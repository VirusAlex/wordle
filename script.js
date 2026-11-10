'use strict';

/* Интерфейс помощника. Логика подбора слов живёт в engine.js. */

const WORD_LENGTH = WordEngine.WORD_LENGTH;
const MAX_ATTEMPTS = 6;
const STATE_MAX_AGE = 24 * 60 * 60 * 1000; // сохранённые попытки живут сутки
const VISIBLE_WORDS = 240;                 // столько подходящих слов показываем сразу
const MOVES_SHOWN = 7;                     // ходов в списке под лучшим
const TOP_WORDS = 3;                       // столько сильнейших слов выделяем в общем списке
const LETTER_CHECKS_SHOWN = 5;             // слов в списке «Проверка букв»
const LETTER_SHARES_SHOWN = 10;            // букв в строке самых частых

const COLORS = ['gray', 'white', 'yellow'];
const MARK_LABELS = { gray: 'нет', white: 'не тут', yellow: 'тут' };
const MARK_NAMES = {
    gray: 'буквы нет в слове',
    white: 'буква есть, но не на этом месте',
    yellow: 'буква на своём месте'
};

function plural(count, one, few, many) {
    const mod10 = count % 10;
    const mod100 = count % 100;
    if (mod10 === 1 && mod100 !== 11) {
        return one;
    }
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) {
        return few;
    }
    return many;
}

function formatCount(count) {
    return count.toLocaleString('ru-RU');
}

function wordsLabel(count) {
    return `${formatCount(count)} ${plural(count, 'слово', 'слова', 'слов')}`;
}

// «Обычно остаётся N слов»: дробные значения по-русски требуют «слова».
function formatLeft(value) {
    if (value >= 9.95) {
        return formatCount(Math.round(value));
    }
    return value.toFixed(1).replace('.', ',');
}

function formatShare(share) {
    const percent = Math.round(share * 100);
    if (percent === 0) {
        return '<1%';
    }
    return `${Math.min(percent, 99)}%`;
}

function leftLabel(value) {
    if (value >= 9.95) {
        return wordsLabel(Math.round(value));
    }
    return `${formatLeft(value)} слова`;
}

class WordlyHelper {
    constructor() {
        this.language = 'ru';
        this.attempts = [];
        this.candidates = [];
        this.ranking = null;
        this.sortMode = 'score';
        this.showAll = false;
        this.analysisId = 0;
        this.analysisTimeout = null;
        this.toastTimeout = null;
        this.rankCache = new Map();
        this.builtDictionaries = {};

        const frequency = typeof WORD_FREQUENCY !== 'undefined' ? WORD_FREQUENCY : {};
        this.languages = {
            ru: {
                words: typeof RUSSIAN_WORDS !== 'undefined' ? RUSSIAN_WORDS : [],
                frequency: frequency.ru,
                notLetter: /[^а-я]/g,
                validWord: /^[а-я]{5}$/
            },
            en: {
                words: typeof ENGLISH_WORDS !== 'undefined' ? ENGLISH_WORDS : [],
                frequency: frequency.en,
                notLetter: /[^a-z]/g,
                validWord: /^[a-z]{5}$/
            }
        };

        this.board = document.getElementById('attempts-container');
        this.init();
    }

    /* ---------- Состояние ---------- */

    get storageKey() {
        // Русский словарь хранится под прежним ключом, чтобы старые попытки не потерялись.
        return this.language === 'ru' ? '5bukv-state' : `5bukv-state-${this.language}`;
    }

    get config() {
        return this.languages[this.language];
    }

    get dictionary() {
        if (!this.builtDictionaries[this.language]) {
            const { words, validWord, frequency } = this.config;
            this.builtDictionaries[this.language] = WordEngine.buildDictionary(words, validWord, frequency);
        }
        return this.builtDictionaries[this.language];
    }

    init() {
        this.bindEvents();

        try {
            const savedLanguage = localStorage.getItem('5bukv-language');
            if (Object.hasOwn(this.languages, savedLanguage)) {
                this.language = savedLanguage;
            }
            this.setPalette(localStorage.getItem('5bukv-palette'), false);
        } catch (error) {
            console.warn('Не удалось прочитать настройки:', error);
        }

        this.loadState();
        this.updateLanguageSwitch();
        this.renderBoard();
        this.analyze();

        // На устройствах с мышью сразу ставим курсор; на телефоне не поднимаем клавиатуру без спроса.
        if (window.matchMedia('(pointer: fine)').matches) {
            this.focusFirstFree();
        }
    }

    emptyAttempt() {
        return { word: '', colors: Array(WORD_LENGTH).fill('gray') };
    }

    letterAt(attempt, position) {
        return (attempt.word[position] || '').trim();
    }

    isComplete(attempt) {
        return this.config.validWord.test(attempt.word);
    }

    isEmpty(attempt) {
        return attempt.word.trim() === '';
    }

    isSolved(attempt) {
        return this.isComplete(attempt) && attempt.colors.every(color => color === 'yellow');
    }

    completeAttempts() {
        return this.attempts.filter(attempt => this.isComplete(attempt));
    }

    sanitize(value) {
        return WordEngine.normalize(value).replace(this.config.notLetter, '');
    }

    // Приводит сохранённые или восстановленные попытки к рабочему виду.
    adoptAttempts(saved) {
        const attempts = [];
        for (const item of Array.isArray(saved) ? saved : []) {
            if (!item || typeof item.word !== 'string') {
                continue;
            }
            const letters = Array.from({ length: WORD_LENGTH }, (_, i) =>
                this.sanitize(item.word[i] || '') || ' ');
            const attempt = {
                word: letters.join('').trimEnd(),
                colors: Array.from({ length: WORD_LENGTH }, (_, i) =>
                    COLORS.includes(item.colors && item.colors[i]) ? item.colors[i] : 'gray')
            };
            if (!this.isEmpty(attempt)) {
                attempts.push(attempt);
            }
        }
        this.attempts = attempts.slice(0, MAX_ATTEMPTS);
        this.ensureFreeRow(false);
        if (this.attempts.length === 0) {
            this.attempts.push(this.emptyAttempt());
        }
    }

    saveState() {
        try {
            localStorage.setItem(this.storageKey, JSON.stringify({
                attempts: this.attempts,
                timestamp: Date.now()
            }));
            localStorage.setItem('5bukv-language', this.language);
        } catch (error) {
            console.warn('Не удалось сохранить попытки:', error);
        }
    }

    loadState() {
        let saved = null;
        try {
            const state = JSON.parse(localStorage.getItem(this.storageKey));
            if (state && Date.now() - state.timestamp <= STATE_MAX_AGE) {
                saved = state.attempts;
            } else if (state) {
                localStorage.removeItem(this.storageKey);
            }
        } catch (error) {
            console.warn('Не удалось загрузить попытки:', error);
        }
        this.adoptAttempts(saved);
    }

    /* ---------- События ---------- */

    bindEvents() {
        this.board.addEventListener('input', event => {
            if (event.target.classList.contains('tile')) {
                this.onTileInput(event.target);
            }
        });
        this.board.addEventListener('keydown', event => {
            if (event.target.classList.contains('tile')) {
                this.onTileKeyDown(event, event.target);
            }
        });
        // Экранные клавиатуры не всегда сообщают о Backspace через keydown.
        this.board.addEventListener('beforeinput', event => {
            const tile = event.target;
            if (tile.classList.contains('tile') && event.inputType === 'deleteContentBackward' && tile.value === '') {
                event.preventDefault();
                this.stepBack(tile);
            }
        });
        this.board.addEventListener('paste', event => {
            if (event.target.classList.contains('tile')) {
                event.preventDefault();
                const text = (event.clipboardData || window.clipboardData).getData('text');
                this.typeLetters(Number(event.target.dataset.row), Number(event.target.dataset.pos), this.sanitize(text));
            }
        });
        this.board.addEventListener('focusin', event => {
            if (event.target.classList.contains('tile')) {
                event.target.select();
            }
        });
        this.board.addEventListener('click', event => {
            const mark = event.target.closest('.mark');
            const remove = event.target.closest('.row-remove');
            if (mark) {
                this.cycleMark(Number(mark.dataset.row), Number(mark.dataset.pos));
            } else if (remove) {
                this.removeAttempt(Number(remove.dataset.row));
            }
        });

        document.getElementById('reset').addEventListener('click', () => this.reset());

        document.querySelectorAll('[data-language]').forEach(button => {
            button.addEventListener('click', () => this.switchLanguage(button.dataset.language));
        });
        document.querySelectorAll('[data-palette]').forEach(button => {
            button.addEventListener('click', () => this.setPalette(button.dataset.palette, true));
        });
        document.querySelectorAll('[data-sort]').forEach(button => {
            button.addEventListener('click', () => {
                this.sortMode = button.dataset.sort;
                this.renderCandidates();
            });
        });
        document.getElementById('show-all').addEventListener('click', () => {
            this.showAll = true;
            this.renderCandidates();
        });

        // Любое слово в подсказках добавляется в попытки по нажатию.
        document.getElementById('results').addEventListener('click', event => {
            const target = event.target.closest('[data-word]');
            if (target) {
                this.addWord(target.dataset.word);
            }
        });

        document.getElementById('toast-action').addEventListener('click', () => {
            const action = this.toastAction;
            this.hideToast();
            if (action) {
                action();
            }
        });
    }

    /* ---------- Поле попыток ---------- */

    cellHTML(attempt, row, position) {
        const letter = this.letterAt(attempt, position);
        const state = letter ? attempt.colors[position] : 'empty';
        return `
            <div class="cell">
                <input class="tile ${state}" type="text" inputmode="text" lang="${this.language}"
                       autocomplete="off" autocapitalize="characters" autocorrect="off" spellcheck="false"
                       enterkeyhint="next" aria-label="Попытка ${row + 1}, буква ${position + 1}"
                       data-row="${row}" data-pos="${position}" value="${letter.toUpperCase()}">
                <button type="button" class="mark ${state}" data-row="${row}" data-pos="${position}"
                        ${letter ? '' : 'disabled'}
                        aria-label="${this.markLabel(letter, attempt.colors[position])}">${letter ? MARK_LABELS[attempt.colors[position]] : ''}</button>
            </div>`;
    }

    markLabel(letter, color) {
        return letter
            ? `Буква ${letter.toUpperCase()}: ${MARK_NAMES[color]}. Нажмите, чтобы изменить`
            : 'Сначала впишите букву';
    }

    rowHTML(attempt, row) {
        const cells = Array.from({ length: WORD_LENGTH }, (_, i) => this.cellHTML(attempt, row, i)).join('');
        return `
            <div class="row${this.isEmpty(attempt) ? ' is-empty' : ''}" data-row="${row}">
                <span class="row-number" aria-hidden="true">${row + 1}</span>
                <div class="cells">${cells}</div>
                <button type="button" class="row-remove" data-row="${row}"
                        aria-label="Удалить попытку ${row + 1}" title="Удалить попытку">×</button>
                <p class="row-note" hidden></p>
            </div>`;
    }

    renderBoard() {
        this.board.innerHTML = this.attempts.map((attempt, row) => this.rowHTML(attempt, row)).join('');
        this.updateRowNotes();
    }

    rowElement(row) {
        return this.board.querySelector(`.row[data-row="${row}"]`);
    }

    tileElement(row, position) {
        return this.board.querySelector(`.tile[data-row="${row}"][data-pos="${position}"]`);
    }

    focusTile(row, position) {
        const tile = this.tileElement(row, position);
        if (tile) {
            tile.focus();
        }
    }

    focusFirstFree() {
        for (let row = 0; row < this.attempts.length; row++) {
            if (!this.isComplete(this.attempts[row])) {
                for (let position = 0; position < WORD_LENGTH; position++) {
                    if (!this.letterAt(this.attempts[row], position)) {
                        this.focusTile(row, position);
                        return;
                    }
                }
            }
        }
    }

    // Если буква уже найдена на этом месте в другой попытке, игра снова покажет её на месте.
    knownColor(letter, position, exceptRow) {
        const known = this.attempts.some((attempt, row) =>
            row !== exceptRow && this.isComplete(attempt) &&
            attempt.colors[position] === 'yellow' && attempt.word[position] === letter);
        return known ? 'yellow' : 'gray';
    }

    setCell(row, position, letter) {
        const attempt = this.attempts[row];
        const letters = Array.from({ length: WORD_LENGTH }, (_, i) => attempt.word[i] || ' ');
        letters[position] = letter || ' ';
        attempt.word = letters.join('').trimEnd();
        attempt.colors[position] = letter ? this.knownColor(letter, position, row) : 'gray';
        this.refreshCell(row, position);
    }

    refreshCell(row, position) {
        const attempt = this.attempts[row];
        const letter = this.letterAt(attempt, position);
        const state = letter ? attempt.colors[position] : 'empty';
        const tile = this.tileElement(row, position);
        const mark = tile.nextElementSibling;
        tile.value = letter.toUpperCase();
        tile.className = `tile ${state}`;
        mark.className = `mark ${state}`;
        mark.disabled = !letter;
        mark.textContent = letter ? MARK_LABELS[attempt.colors[position]] : '';
        mark.setAttribute('aria-label', this.markLabel(letter, attempt.colors[position]));
        this.rowElement(row).classList.toggle('is-empty', this.isEmpty(attempt));
    }

    // Держит под рукой свободную строку для следующей попытки.
    ensureFreeRow(updateDom = true) {
        const last = this.attempts[this.attempts.length - 1];
        if (last && this.isComplete(last) && this.attempts.length < MAX_ATTEMPTS) {
            this.attempts.push(this.emptyAttempt());
            if (updateDom) {
                this.board.insertAdjacentHTML('beforeend',
                    this.rowHTML(this.attempts[this.attempts.length - 1], this.attempts.length - 1));
            }
        }
    }

    updateRowNotes() {
        this.attempts.forEach((attempt, row) => {
            const element = this.rowElement(row);
            if (!element) {
                return;
            }
            const note = element.querySelector('.row-note');
            const unknown = this.isComplete(attempt) && !this.dictionary.index.has(attempt.word);
            note.hidden = !unknown;
            note.textContent = unknown ? 'Этого слова нет в словаре. Подсказки всё равно его учитывают.' : '';
        });
    }

    boardChanged(delay = 200) {
        this.ensureFreeRow();
        this.updateRowNotes();
        this.saveState();
        this.scheduleAnalysis(delay);
    }

    onTileInput(tile) {
        const row = Number(tile.dataset.row);
        const position = Number(tile.dataset.pos);
        const previous = this.letterAt(this.attempts[row], position);
        let letters = this.sanitize(tile.value);

        // Букву напечатали поверх старой: оставляем новую.
        if (previous && letters.length === 2) {
            letters = letters.replace(previous, '') || previous;
        }

        if (letters.length <= 1) {
            this.setCell(row, position, letters);
            if (letters && position < WORD_LENGTH - 1) {
                this.focusTile(row, position + 1);
            }
            this.boardChanged();
        } else {
            this.typeLetters(row, position, letters);
        }
    }

    // Раскладывает несколько букв по клеткам: вставка из буфера или ввод слова целиком.
    typeLetters(row, position, letters) {
        if (!letters) {
            return;
        }
        const count = Math.min(letters.length, WORD_LENGTH - position);
        for (let i = 0; i < count; i++) {
            this.setCell(row, position + i, letters[i]);
        }
        this.focusTile(row, Math.min(position + count, WORD_LENGTH - 1));
        this.boardChanged();
    }

    stepBack(tile) {
        const row = Number(tile.dataset.row);
        const position = Number(tile.dataset.pos);
        if (position === 0) {
            return;
        }
        this.setCell(row, position - 1, '');
        this.focusTile(row, position - 1);
        this.boardChanged();
    }

    onTileKeyDown(event, tile) {
        if (event.ctrlKey || event.metaKey || event.altKey) {
            return;
        }
        const row = Number(tile.dataset.row);
        const position = Number(tile.dataset.pos);
        const move = (toRow, toPosition) => {
            event.preventDefault();
            this.focusTile(toRow, toPosition);
        };

        switch (event.key) {
            case 'Backspace':
                if (!tile.value) {
                    event.preventDefault();
                    this.stepBack(tile);
                }
                break;
            case 'ArrowLeft':
                if (position > 0) { move(row, position - 1); }
                break;
            case 'ArrowRight':
                if (position < WORD_LENGTH - 1) { move(row, position + 1); }
                break;
            case 'ArrowUp':
                if (row > 0) { move(row - 1, position); }
                break;
            case 'ArrowDown':
                if (row < this.attempts.length - 1) { move(row + 1, position); }
                break;
            case 'Enter':
                if (row < this.attempts.length - 1) { move(row + 1, 0); }
                break;
            case ' ':
                event.preventDefault();
                this.cycleMark(row, position);
                break;
            case '1':
            case '2':
            case '3':
                event.preventDefault();
                this.cycleMark(row, position, COLORS[Number(event.key) - 1]);
                break;
        }
    }

    cycleMark(row, position, color) {
        const attempt = this.attempts[row];
        if (!this.letterAt(attempt, position)) {
            return;
        }
        attempt.colors[position] = color ||
            COLORS[(COLORS.indexOf(attempt.colors[position]) + 1) % COLORS.length];
        this.refreshCell(row, position);
        this.boardChanged(120);
    }

    removeAttempt(row) {
        this.attempts.splice(row, 1);
        this.adoptAttempts(this.attempts);
        this.renderBoard();
        this.saveState();
        this.scheduleAnalysis(0);
    }

    addWord(word) {
        let row = this.attempts.findIndex(attempt => this.isEmpty(attempt));
        if (row === -1) {
            if (this.attempts.length >= MAX_ATTEMPTS) {
                this.showToast('Все шесть попыток заняты. Удалите одну или начните новую игру.');
                return;
            }
            row = this.attempts.length;
            this.attempts.push(this.emptyAttempt());
        }

        const attempt = this.attempts[row];
        attempt.word = word;
        attempt.colors = Array.from(word, (letter, position) => this.knownColor(letter, position, row));
        this.ensureFreeRow(false);
        this.renderBoard();

        const element = this.rowElement(row);
        element.classList.add('is-new');
        element.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

        this.saveState();
        this.scheduleAnalysis(0);
        this.showToast(`Слово ${word.toUpperCase()} добавлено в попытки. Отметьте, что показала игра.`);

        // Заодно кладём слово в буфер обмена: его удобно вставить в игру.
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(word.toUpperCase()).catch(() => {});
        }
    }

    reset() {
        if (this.attempts.every(attempt => this.isEmpty(attempt))) {
            this.focusFirstFree();
            return;
        }
        const language = this.language;
        const previous = JSON.stringify(this.attempts);
        this.adoptAttempts([]);
        this.renderBoard();
        this.saveState();
        this.scheduleAnalysis(0);
        this.showToast('Попытки очищены.', 'Вернуть', () => {
            if (this.language !== language) {
                return;
            }
            this.adoptAttempts(JSON.parse(previous));
            this.renderBoard();
            this.saveState();
            this.scheduleAnalysis(0);
        });
        if (window.matchMedia('(pointer: fine)').matches) {
            this.focusFirstFree();
        }
    }

    /* ---------- Настройки ---------- */

    updateLanguageSwitch() {
        document.querySelectorAll('[data-language]').forEach(button => {
            button.setAttribute('aria-pressed', String(button.dataset.language === this.language));
        });
    }

    switchLanguage(language) {
        if (!Object.hasOwn(this.languages, language) || language === this.language) {
            return;
        }
        this.saveState();
        this.hideToast();
        this.language = language;
        this.showAll = false;
        this.loadState();
        this.saveState();
        this.updateLanguageSwitch();
        this.renderBoard();
        this.scheduleAnalysis(0);
    }

    setPalette(palette, remember) {
        const value = palette === 'wordle' ? 'wordle' : 'classic';
        document.documentElement.dataset.palette = value;
        document.querySelectorAll('[data-palette]').forEach(button => {
            button.setAttribute('aria-pressed', String(button.dataset.palette === value));
        });
        if (remember) {
            try {
                localStorage.setItem('5bukv-palette', value);
            } catch (error) {
                console.warn('Не удалось сохранить цвета:', error);
            }
        }
    }

    /* ---------- Подсказки ---------- */

    scheduleAnalysis(delay) {
        clearTimeout(this.analysisTimeout);
        this.analysisTimeout = setTimeout(() => this.analyze(), delay);
    }

    async analyze() {
        clearTimeout(this.analysisTimeout);
        const id = ++this.analysisId;
        const dictionary = this.dictionary;
        const attempts = this.completeAttempts();
        const solved = attempts.find(attempt => this.isSolved(attempt));

        this.ranking = null;
        this.hasAttempts = attempts.length > 0;
        this.candidates = solved ? [] : WordEngine.filterCandidates(dictionary, attempts);
        const count = this.candidates.length;
        const total = dictionary.words.length;

        if (solved || count === 0) {
            this.setProgress(null);
            this.setSection('best', false);
            this.setSection('moves', false);
            this.setSection('letters', false);
            this.setSection('candidates', false);
            if (solved) {
                this.setStatus(`Слово разгадано: ${solved.word.toUpperCase()}`,
                    'Когда в игре появится новое слово, нажмите «Новая игра».');
            } else if (total === 0) {
                this.setStatus('Словарь не загрузился', 'Проверьте, что рядом со страницей лежат файлы словарей, и обновите её.');
            } else {
                this.setStatus('Ни одно слово не подходит',
                    'Проверьте отметки под буквами: скорее всего, одна из них не совпадает с игрой. ' +
                    'Если всё верно, загаданного слова нет в словаре.');
            }
            return;
        }

        if (count === 1) {
            this.setProgress(null);
            this.setStatus('Осталось одно слово', '');
            this.renderAnswer(dictionary.words[this.candidates[0]]);
            this.setSection('moves', false);
            this.setSection('letters', false);
            this.setSection('candidates', false);
            return;
        }

        if (this.hasAttempts) {
            this.setStatus(`${plural(count, 'Подходит', 'Подходят', 'Подходит')} ${wordsLabel(count)} из ${formatCount(total)}`, '');
        } else {
            this.setStatus('С чего начать',
                `Попыток пока нет. В словаре ${wordsLabel(total)}, и эти в среднем отсекают больше всего.`);
        }
        this.showAll = false;
        this.renderLetterChecks();
        this.renderCandidates();

        const key = `${this.language}|${attempts.map(a => `${a.word}:${a.colors.join('')}`).sort().join('|')}`;
        let ranking = this.rankCache.get(key);
        if (!ranking) {
            document.getElementById('best').classList.add('is-stale');
            document.getElementById('moves').classList.add('is-stale');
            this.setProgress(0);
            ranking = await WordEngine.rankGuesses(dictionary, this.candidates, {
                isCancelled: () => id !== this.analysisId,
                onProgress: share => this.setProgress(share)
            });
            if (!ranking || id !== this.analysisId) {
                return;
            }
            this.rankCache.set(key, ranking);
            if (this.rankCache.size > 24) {
                this.rankCache.delete(this.rankCache.keys().next().value);
            }
        }

        this.setProgress(null);
        this.ranking = ranking;
        this.renderBest();
        this.renderMoves();
        this.renderCandidates();
    }

    setStatus(title, text) {
        document.getElementById('status-title').textContent = title;
        const textElement = document.getElementById('status-text');
        textElement.textContent = text;
        textElement.hidden = !text;
    }

    setProgress(share) {
        const progress = document.getElementById('progress');
        progress.hidden = share === null;
        if (share !== null) {
            document.getElementById('progress-bar').style.width = `${Math.round(share * 100)}%`;
        }
    }

    setSection(id, visible) {
        const section = document.getElementById(id);
        section.hidden = !visible;
        section.classList.remove('is-stale');
    }

    tilesHTML(word) {
        return Array.from(word, letter => `<span class="ghost-tile">${letter.toUpperCase()}</span>`).join('');
    }

    renderAnswer(word) {
        document.getElementById('best').innerHTML = `
            <div class="best-head"><h3>Ответ</h3></div>
            <button type="button" class="best-word" data-word="${word}"
                    aria-label="Добавить слово ${word.toUpperCase()} в попытки">${this.tilesHTML(word)}</button>
            <p class="best-text">Других слов, подходящих под ваши отметки, в словаре нет.</p>
            <button type="button" class="button button-accent" data-word="${word}">Добавить в попытки</button>`;
        this.setSection('best', true);
    }

    moveTag(index) {
        if (!this.hasAttempts) {
            return '';
        }
        return this.ranking.isCandidate[index]
            ? '<span class="tag tag-answer">может быть ответом</span>'
            : '<span class="tag">разведка</span>';
    }

    // Доля неизвестного, которую в среднем снимает ход: от 0 до 1.
    power(index) {
        const { entropy, maxEntropy } = this.ranking;
        return maxEntropy > 0 ? Math.min(1, entropy[index] / maxEntropy) : 1;
    }

    renderBest() {
        const { order, typicalLeft, winChance, isCandidate, total } = this.ranking;
        const index = order[0];
        const word = this.dictionary.words[index];

        let text = typicalLeft[index] < 1.05
            ? `Этот ход обычно сразу показывает, какое из ${formatCount(total)} слов загадано.`
            : `После ${this.hasAttempts ? 'этого хода' : 'него'} обычно остаётся ${leftLabel(typicalLeft[index])} из ${formatCount(total)}.`;
        if (this.hasAttempts && isCandidate[index]) {
            const chance = Math.round(winChance[index] * 100);
            text += chance >= 2
                ? ` Слово может сразу оказаться ответом: шанс около ${chance}%.`
                : ' Слово может оказаться и ответом.';
        } else if (this.hasAttempts) {
            text += ' Само слово ответом быть не может: это ход на разведку.';
        }

        document.getElementById('best').innerHTML = `
            <div class="best-head"><h3>${this.hasAttempts ? 'Лучший ход' : 'Лучшее первое слово'}</h3>${this.moveTag(index)}</div>
            <button type="button" class="best-word" data-word="${word}"
                    aria-label="Добавить слово ${word.toUpperCase()} в попытки">${this.tilesHTML(word)}</button>
            <p class="best-text">${text}</p>
            <button type="button" class="button button-accent" data-word="${word}">Добавить в попытки</button>`;
        this.setSection('best', true);
    }

    renderMoves() {
        const { order, typicalLeft, isCandidate } = this.ranking;
        const words = this.dictionary.words;
        // Когда осталось два слова, разведка бессмысленна: предлагаем только их.
        const pool = this.candidates.length <= 2 ? order.filter(index => isCandidate[index]) : order;
        const items = pool.slice(1, 1 + MOVES_SHOWN).map((index, i) => `
            <li>
                <button type="button" class="move" data-word="${words[index]}">
                    <span class="move-rank">${i + 2}</span>
                    <span class="move-word">${words[index].toUpperCase()}</span>
                    ${this.moveTag(index)}
                    <span class="meter" aria-hidden="true"><span style="width:${Math.round(this.power(index) * 100)}%"></span></span>
                    <span class="move-left">${formatLeft(typicalLeft[index])}</span>
                </button>
            </li>`);
        document.getElementById('moves-title').textContent =
            this.hasAttempts ? 'Другие сильные ходы' : 'Другие сильные начала';
        document.getElementById('moves-list').innerHTML = items.join('');
        this.setSection('moves', items.length > 0);
    }

    // Второй способ выбрать ход: не сужать список слов, а разом проверить побольше букв.
    renderLetterChecks() {
        const { words } = this.dictionary;
        const checks = this.candidates.length > 2
            ? WordEngine.rankLetterChecks(this.dictionary, this.candidates, LETTER_CHECKS_SHOWN)
            : { letters: [], moves: [], shares: new Map() };
        if (checks.moves.length === 0) {
            this.setSection('letters', false);
            return;
        }

        document.getElementById('letters-top').innerHTML = checks.letters.slice(0, LETTER_SHARES_SHOWN)
            .map(({ letter, share }) =>
                `<li><b>${letter.toUpperCase()}</b>${formatShare(share)}</li>`).join('');

        document.getElementById('letters-list').innerHTML = checks.moves.map((move, i) => {
            const word = words[move.index];
            const cells = Array.from(word, (letter, position) => {
                const share = checks.shares.get(letter) || 0;
                // Букву проверяем один раз, и только если про неё ещё не всё ясно.
                const checked = share > 0 && share < 1 && word.indexOf(letter) === position;
                return `<span class="check-letter${checked ? '' : ' is-known'}"><b>${letter.toUpperCase()}</b>` +
                    `<small>${checked ? formatShare(share) : ''}</small></span>`;
            }).join('');
            const tag = this.hasAttempts && move.isCandidate
                ? '<span class="tag tag-answer">может быть ответом</span>' : '';
            return `
                <li>
                    <button type="button" class="check" data-word="${word}"
                            aria-label="Добавить слово ${word.toUpperCase()} в попытки">
                        <span class="move-rank">${i + 1}</span>
                        <span class="check-letters">${cells}</span>
                        ${tag}
                    </button>
                </li>`;
        }).join('');
        this.setSection('letters', true);
    }

    renderCandidates() {
        const section = document.getElementById('candidates');
        if (!this.hasAttempts || this.candidates.length < 2) {
            this.setSection('candidates', false);
            return;
        }

        const { words, tiers, hasTiers } = this.dictionary;
        const ranking = this.ranking;
        let list = this.candidates.slice();
        const byScore = this.sortMode === 'score';
        if (byScore && ranking) {
            // Редкие слова уходят в конец: их загадывают нечасто, какой бы сильной ни была оценка.
            list.sort((a, b) => (tiers[a] === 0) - (tiers[b] === 0) ||
                ranking.score[b] - ranking.score[a] || a - b);
        } else if (byScore) {
            // Оценки ещё считаются: пока ставим вперёд частые слова.
            list.sort((a, b) => tiers[b] - tiers[a] || a - b);
        }

        const top = new Set(ranking
            ? ranking.order.filter(index => ranking.isCandidate[index]).slice(0, TOP_WORDS)
            : []);
        const hiddenCount = this.showAll ? 0 : Math.max(0, list.length - VISIBLE_WORDS);
        if (hiddenCount > 0) {
            list = list.slice(0, VISIBLE_WORDS);
        }

        document.getElementById('matching-words').innerHTML = list.map(index => {
            const classes = ['word', `tier-${tiers[index]}`];
            if (top.has(index)) {
                classes.push('is-top');
            }
            const title = ranking ? ` title="Обычно остаётся ${leftLabel(ranking.typicalLeft[index])}"` : '';
            const power = ranking ? ` style="--power:${this.power(index).toFixed(3)}"` : '';
            return `<button type="button" class="${classes.join(' ')}" data-word="${words[index]}"${title}${power}>${words[index].toUpperCase()}</button>`;
        }).join('');

        const hasRare = hasTiers && this.candidates.some(index => tiers[index] === 0);
        document.getElementById('candidates-hint').textContent =
            'Нажмите на слово, чтобы добавить его в попытки. Полоска под словом показывает, насколько ход сужает выбор.' +
            (hasRare ? ' Бледные слова редкие: их загадывают нечасто.' : '');

        const showAll = document.getElementById('show-all');
        showAll.hidden = hiddenCount === 0;
        showAll.textContent = `Показать все ${wordsLabel(this.candidates.length)}`;

        document.querySelectorAll('[data-sort]').forEach(button => {
            button.setAttribute('aria-pressed', String(button.dataset.sort === this.sortMode));
        });
        section.hidden = false;
    }

    /* ---------- Уведомления ---------- */

    showToast(text, actionLabel, action) {
        const toast = document.getElementById('toast');
        const button = document.getElementById('toast-action');
        document.getElementById('toast-text').textContent = text;
        button.hidden = !actionLabel;
        button.textContent = actionLabel || '';
        this.toastAction = action || null;
        toast.hidden = false;
        clearTimeout(this.toastTimeout);
        this.toastTimeout = setTimeout(() => this.hideToast(), actionLabel ? 7000 : 3500);
    }

    hideToast() {
        clearTimeout(this.toastTimeout);
        this.toastAction = null;
        document.getElementById('toast').hidden = true;
    }
}

let wordlyHelper;
document.addEventListener('DOMContentLoaded', () => {
    wordlyHelper = new WordlyHelper();
});

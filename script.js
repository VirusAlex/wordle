class CharRule {
    constructor(charToCheck, isCharAtPosition, charPosition) {
        this.charToCheck = charToCheck;
        this.isCharAtPosition = isCharAtPosition;
        this.charPosition = charPosition;
    }

    apply(str) {
        if (this.charPosition > -1) {
            return this.isCharAtPosition
                ? (this.charToCheck === str.charAt(this.charPosition))
                : (this.charToCheck !== str.charAt(this.charPosition) && str.indexOf(this.charToCheck) > -1);
        } else {
            return this.isCharAtPosition === (str.indexOf(this.charToCheck) === this.charPosition);
        }
    }

    static atPosition(charToCheck, charPosition) {
        return new CharRule(charToCheck, true, charPosition);
    }

    static notAtPosition(charToCheck, charPosition) {
        return new CharRule(charToCheck, false, charPosition);
    }

    static notPresent(charToCheck) {
        return new CharRule(charToCheck, true, -1);
    }

    toString() {
        if (this.charPosition === -1) {
            return `Буква '${this.charToCheck}' отсутствует в слове`;
        } else if (this.isCharAtPosition) {
            return `Буква '${this.charToCheck}' на позиции ${this.charPosition + 1}`;
        } else {
            return `Буква '${this.charToCheck}' НЕ на позиции ${this.charPosition + 1}, но есть в слове`;
        }
    }
}

class Rules {
    constructor() {
        this.charRules = [];
        this.rawWordRules = [];
    }

    apply(str) {
        if (!str) {
            return false;
        }

        const word = str.trim().toLowerCase();
        if (word.length !== 5) {
            return false;
        }

        for (let rule of this.charRules) {
            if (!rule.apply(word)) {
                return false;
            }
        }
        return true;
    }

    reset() {
        this.charRules = [];
        this.rawWordRules = [];
    }

    addRule(attempt) {
        if (!attempt || !attempt.word || attempt.word.length !== 5) {
            return;
        }

        const word = attempt.word.toLowerCase();
        const colors = attempt.colors;

        // Сначала добавляем точные позиции (желтые)
        for (let i = 0; i < 5; i++) {
            if (colors[i] === 'yellow') {
                this.addCharRule(CharRule.atPosition(word[i], i));
            }
        }

        // Затем обрабатываем остальные
        for (let i = 0; i < 5; i++) {
            const char = word[i];
            const color = colors[i];

            if (color === 'gray') {
                // Проверяем, нет ли этой буквы уже в желтых позициях
                const hasYellowSameChar = colors.some((c, idx) => c === 'yellow' && word[idx] === char);
                if (!hasYellowSameChar) {
                    this.addCharRule(CharRule.notPresent(char));
                }
            } else if (color === 'white') {
                this.addCharRule(CharRule.notAtPosition(char, i));
            }
        }
    }

    addCharRule(rule) {
        console.log('Добавлено правило:', rule.toString());
        this.charRules.push(rule);
    }

    getGuessedLetters() {
        const letters = new Set();
        for (let rule of this.charRules) {
            if (rule.charPosition > -1 && rule.isCharAtPosition) {
                letters.add(rule.charToCheck);
            }
        }
        return letters;
    }
}

class WordlyHelper {
    constructor() {
        this.rules = new Rules();
        this.attempts = [];
        this.words = [];
        this.autoAnalyzeTimeout = null;
        this.storageKey = '5bukv-state';
        this.init();
    }

    init() {
        this.bindEvents();
        
        // Загружаем слова
        if (typeof RUSSIAN_WORDS !== 'undefined') {
            this.words = RUSSIAN_WORDS.filter(word => word.length === 5);
            console.log(`Загружено ${this.words.length} пятибуквенных слов`);
        } else {
            console.error('Словарь не загружен');
        }

        // Пытаемся загрузить сохраненное состояние
        const stateLoaded = this.loadState();
        
        if (stateLoaded && this.attempts.length > 0) {
            // Если состояние загружено, восстанавливаем интерфейс
            this.restoreInterface();
            console.log('Состояние восстановлено из localStorage');
        } else {
            // Если состояние не загружено, добавляем первую попытку
            this.addNewAttempt();
        }

        // Первоначальный анализ
        this.autoAnalyze();
    }

    bindEvents() {
        document.getElementById('add-attempt').addEventListener('click', () => this.addNewAttempt());
        document.getElementById('analyze').addEventListener('click', () => this.analyze(true)); // Со скроллингом для ручного поиска
        document.getElementById('reset').addEventListener('click', () => this.reset());
    }

    addNewAttempt() {
        const container = document.getElementById('attempts-container');
        const attemptIndex = this.attempts.length;
        
        const attemptDiv = document.createElement('div');
        attemptDiv.className = 'attempt';
        attemptDiv.dataset.index = attemptIndex;

        attemptDiv.innerHTML = `
            <div class="attempt-header">
                <span class="attempt-number">Попытка ${attemptIndex + 1}</span>
                <button class="remove-attempt" onclick="wordlyHelper.removeAttempt(${attemptIndex})">×</button>
            </div>
            <div class="letter-row">
                ${Array.from({length: 5}, (_, i) => `
                    <input type="text" class="letter-input" maxlength="1" 
                           data-attempt="${attemptIndex}" data-position="${i}"
                           oninput="wordlyHelper.handleLetterInput(this)"
                           onkeydown="wordlyHelper.handleKeyDown(event, this)">
                `).join('')}
            </div>
            <div class="color-buttons">
                ${Array.from({length: 5}, (_, i) => `
                    <div class="color-btn-group">
                        <button class="color-btn gray" onclick="wordlyHelper.setLetterColor(${attemptIndex}, ${i}, 'gray')"></button>
                        <button class="color-btn white" onclick="wordlyHelper.setLetterColor(${attemptIndex}, ${i}, 'white')"></button>
                        <button class="color-btn yellow" onclick="wordlyHelper.setLetterColor(${attemptIndex}, ${i}, 'yellow')"></button>
                    </div>
                `).join('')}
            </div>
        `;

        container.appendChild(attemptDiv);
        
        this.attempts.push({
            word: '',
            colors: ['gray', 'gray', 'gray', 'gray', 'gray']
        });

        // Фокус на первую букву
        attemptDiv.querySelector('.letter-input').focus();
        
        // Сохраняем состояние
        this.saveState();
    }

    removeAttempt(index) {
        if (this.attempts.length <= 1) {
            return; // Оставляем хотя бы одну попытку
        }

        this.attempts.splice(index, 1);
        this.renderAttempts();
        
        // Автоматический анализ после удаления попытки
        this.autoAnalyze();
        
        // Сохраняем состояние
        this.saveState();
    }

    renderAttempts() {
        const container = document.getElementById('attempts-container');
        container.innerHTML = '';
        
        const tempAttempts = [...this.attempts];
        this.attempts = [];
        
        tempAttempts.forEach((attempt, index) => {
            this.addNewAttempt();
            // Восстанавливаем данные
            this.attempts[index] = attempt;
            this.updateAttemptDisplay(index);
        });
    }

    updateAttemptDisplay(attemptIndex) {
        const attempt = this.attempts[attemptIndex];
        const attemptDiv = document.querySelector(`[data-index="${attemptIndex}"]`);
        
        // Обновляем буквы
        const inputs = attemptDiv.querySelectorAll('.letter-input');
        inputs.forEach((input, i) => {
            input.value = attempt.word[i] || '';
            input.className = `letter-input ${attempt.colors[i]}`;
        });
    }

    handleLetterInput(input) {
        const value = input.value.toUpperCase().replace(/[^А-ЯЁ]/g, '');
        input.value = value;

        const attemptIndex = parseInt(input.dataset.attempt);
        const position = parseInt(input.dataset.position);

        // Обновляем слово в попытке
        let word = this.attempts[attemptIndex].word.split('');
        word[position] = value.toLowerCase();
        this.attempts[attemptIndex].word = word.join('');

        // Автоматически применяем серый цвет при вводе буквы
        if (value) {
            input.className = 'letter-input gray';
            this.attempts[attemptIndex].colors[position] = 'gray';
        } else {
            // Если буква удалена, возвращаем к белому цвету
            input.className = 'letter-input white';
            this.attempts[attemptIndex].colors[position] = 'gray';
        }

        // Переход к следующему полю
        if (value && position < 4) {
            const nextInput = input.parentElement.children[position + 1];
            nextInput.focus();
        }

        // Автоматический анализ при изменении
        this.autoAnalyze();
        
        // Сохраняем состояние
        this.saveState();
    }

    handleKeyDown(event, input) {
        const position = parseInt(input.dataset.position);
        
        if (event.key === 'Backspace' && !input.value && position > 0) {
            const prevInput = input.parentElement.children[position - 1];
            prevInput.focus();
        } else if (event.key === 'ArrowLeft' && position > 0) {
            const prevInput = input.parentElement.children[position - 1];
            prevInput.focus();
        } else if (event.key === 'ArrowRight' && position < 4) {
            const nextInput = input.parentElement.children[position + 1];
            nextInput.focus();
        }
    }

    setLetterColor(attemptIndex, position, color) {
        this.attempts[attemptIndex].colors[position] = color;
        
        const attemptDiv = document.querySelector(`[data-index="${attemptIndex}"]`);
        const input = attemptDiv.querySelectorAll('.letter-input')[position];
        input.className = `letter-input ${color}`;

        // Автоматический анализ при смене цвета
        this.autoAnalyze();
        
        // Сохраняем состояние
        this.saveState();
    }

    analyze(shouldScroll = false) {
        // Сброс правил
        this.rules.reset();

        // Проверяем, что есть хотя бы одна заполненная попытка
        const validAttempts = this.attempts.filter(attempt => 
            attempt.word.length === 5 && /^[а-яё]+$/.test(attempt.word)
        );

        if (validAttempts.length === 0) {
            if (document.getElementById('results').style.display === 'block') {
                document.getElementById('results').style.display = 'none';
            }
            return;
        }

        // Добавляем правила для каждой попытки
        validAttempts.forEach(attempt => {
            this.rules.addRule(attempt);
        });

        // Показываем результаты
        this.showResults(shouldScroll);
    }

    autoAnalyze() {
        // Отменяем предыдущий таймер
        if (this.autoAnalyzeTimeout) {
            clearTimeout(this.autoAnalyzeTimeout);
        }

        // Запускаем новый таймер с задержкой 300ms
        this.autoAnalyzeTimeout = setTimeout(() => {
            this.analyze(false); // Без скроллинга для автоматического поиска
        }, 300);
    }

    saveState() {
        try {
            const state = {
                attempts: this.attempts,
                timestamp: Date.now()
            };
            localStorage.setItem(this.storageKey, JSON.stringify(state));
        } catch (error) {
            console.warn('Не удалось сохранить состояние:', error);
        }
    }

    loadState() {
        try {
            const savedState = localStorage.getItem(this.storageKey);
            if (!savedState) {
                return false;
            }

            const state = JSON.parse(savedState);
            
            // Проверяем, что состояние не слишком старое (максимум 24 часа)
            const maxAge = 24 * 60 * 60 * 1000; // 24 часа в миллисекундах
            if (Date.now() - state.timestamp > maxAge) {
                localStorage.removeItem(this.storageKey);
                return false;
            }

            // Восстанавливаем попытки
            if (state.attempts && Array.isArray(state.attempts)) {
                this.attempts = state.attempts;
                return true;
            }
        } catch (error) {
            console.warn('Не удалось загрузить состояние:', error);
            localStorage.removeItem(this.storageKey);
        }
        return false;
    }

    clearState() {
        try {
            localStorage.removeItem(this.storageKey);
        } catch (error) {
            console.warn('Не удалось очистить состояние:', error);
        }
    }

    restoreInterface() {
        const container = document.getElementById('attempts-container');
        container.innerHTML = '';

        // Восстанавливаем каждую попытку
        this.attempts.forEach((attempt, index) => {
            const attemptDiv = document.createElement('div');
            attemptDiv.className = 'attempt';
            attemptDiv.dataset.index = index;

            attemptDiv.innerHTML = `
                <div class="attempt-header">
                    <span class="attempt-number">Попытка ${index + 1}</span>
                    <button class="remove-attempt" onclick="wordlyHelper.removeAttempt(${index})">×</button>
                </div>
                <div class="letter-row">
                    ${Array.from({length: 5}, (_, i) => `
                        <input type="text" class="letter-input ${attempt.colors[i]}" maxlength="1" 
                               value="${attempt.word[i] ? attempt.word[i].toUpperCase() : ''}"
                               data-attempt="${index}" data-position="${i}"
                               oninput="wordlyHelper.handleLetterInput(this)"
                               onkeydown="wordlyHelper.handleKeyDown(event, this)">
                    `).join('')}
                </div>
                <div class="color-buttons">
                    ${Array.from({length: 5}, (_, i) => `
                        <div class="color-btn-group">
                            <button class="color-btn gray" onclick="wordlyHelper.setLetterColor(${index}, ${i}, 'gray')"></button>
                            <button class="color-btn white" onclick="wordlyHelper.setLetterColor(${index}, ${i}, 'white')"></button>
                            <button class="color-btn yellow" onclick="wordlyHelper.setLetterColor(${index}, ${i}, 'yellow')"></button>
                        </div>
                    `).join('')}
                </div>
            `;

            container.appendChild(attemptDiv);
        });
    }

    showResults(shouldScroll = false) {
        const resultsSection = document.getElementById('results');
        resultsSection.style.display = 'block';

        // Показываем индикатор загрузки
        document.getElementById('matching-words').innerHTML = '<div class="loading">Анализ слов</div>';
        document.getElementById('suggestion-words').innerHTML = '<div class="loading">Поиск предложений</div>';

        // Асинхронная обработка для больших объемов данных
        setTimeout(() => {
            this.processWords(shouldScroll);
        }, 100);
    }

    processWords(shouldScroll = false) {
        const matchingWords = [];
        
        // Собираем все буквы из всех введенных попыток
        const usedLetters = new Set();
        this.attempts.forEach(attempt => {
            if (attempt.word && attempt.word.length === 5) {
                for (let char of attempt.word.toLowerCase()) {
                    usedLetters.add(char);
                }
            }
        });

        // Фильтруем подходящие слова
        for (let word of this.words) {
            if (this.rules.apply(word)) {
                matchingWords.push(word);
            }
        }

        // Находим слова для следующей попытки (без любых уже использованных букв)
        const suggestionWords = this.words.filter(word => {
            // Проверяем, что в слове нет ни одной уже использованной буквы
            for (let char of word.toLowerCase()) {
                if (usedLetters.has(char)) {
                    return false;
                }
            }
            return true;
        }).slice(0, 1000); // Ограничиваем количество для производительности

        this.displayResults(matchingWords, suggestionWords, shouldScroll);
    }

    displayResults(matchingWords, suggestionWords, shouldScroll = false) {
        // Подходящие слова
        const matchingContainer = document.getElementById('matching-words');
        const matchingCount = document.getElementById('matching-count');

        if (matchingWords.length === 0) {
            matchingContainer.innerHTML = '<div class="empty-state">Подходящих слов не найдено 😔</div>';
        } else {
            matchingContainer.innerHTML = matchingWords
                .slice(0, 1000) // Ограничиваем для производительности
                .map(word => `<span class="word-item" onclick="wordlyHelper.copyWord('${word}')">${word.toUpperCase()}</span>`)
                .join('');
        }

        matchingCount.textContent = `Найдено: ${matchingWords.length} слов`;

        // Слова для следующей попытки
        const suggestionContainer = document.getElementById('suggestion-words');
        const suggestionCount = document.getElementById('suggestion-count');

        if (suggestionWords.length === 0) {
            suggestionContainer.innerHTML = '<div class="empty-state">Нет подходящих слов для следующей попытки</div>';
        } else {
            suggestionContainer.innerHTML = suggestionWords
                .slice(0, 1000)
                .map(word => `<span class="word-item" onclick="wordlyHelper.copyWord('${word}')">${word.toUpperCase()}</span>`)
                .join('');
        }

        suggestionCount.textContent = `Найдено: ${suggestionWords.length} слов`;

        // Скроллим к результатам только при ручном поиске
        if (shouldScroll) {
            document.getElementById('results').scrollIntoView({ behavior: 'smooth' });
        }
    }

    copyWord(word) {
        // Копируем в буфер обмена
        navigator.clipboard.writeText(word.toUpperCase()).then(() => {
            // Добавляем новую попытку
            this.addNewAttempt();
            const newAttemptIndex = this.attempts.length - 1;
            
            // Заполняем слово в новую попытку
            this.attempts[newAttemptIndex].word = word.toLowerCase();
            
            // Обновляем отображение
            const attemptDiv = document.querySelector(`[data-index="${newAttemptIndex}"]`);
            const inputs = attemptDiv.querySelectorAll('.letter-input');
            
            // Заполняем буквы и применяем серый цвет по умолчанию
            for (let i = 0; i < word.length; i++) {
                inputs[i].value = word[i].toUpperCase();
                inputs[i].className = 'letter-input gray';
                this.attempts[newAttemptIndex].colors[i] = 'gray';
            }
            
            // Показываем уведомление
            const notification = document.createElement('div');
            notification.style.cssText = `
                position: fixed;
                top: 20px;
                right: 20px;
                background: #667eea;
                color: white;
                padding: 12px 20px;
                border-radius: 8px;
                z-index: 1000;
                font-weight: 500;
                box-shadow: 0 4px 12px rgba(0,0,0,0.15);
            `;
            notification.textContent = `Добавлено: ${word.toUpperCase()} ✨`;
            document.body.appendChild(notification);
            
            // Скроллим к новой попытке
            attemptDiv.scrollIntoView({ behavior: 'smooth', block: 'center' });
            
            // Автоматический анализ после добавления слова
            this.autoAnalyze();
            
            // Сохраняем состояние
            this.saveState();
            
            // Убираем уведомление
            setTimeout(() => {
                notification.remove();
            }, 2500);
        }).catch(() => {
            // Если копирование не удалось, всё равно добавляем попытку
            this.addNewAttempt();
            const newAttemptIndex = this.attempts.length - 1;
            this.attempts[newAttemptIndex].word = word.toLowerCase();
            
            const attemptDiv = document.querySelector(`[data-index="${newAttemptIndex}"]`);
            const inputs = attemptDiv.querySelectorAll('.letter-input');
            
            for (let i = 0; i < word.length; i++) {
                inputs[i].value = word[i].toUpperCase();
                inputs[i].className = 'letter-input gray';
                this.attempts[newAttemptIndex].colors[i] = 'gray';
            }
            
            attemptDiv.scrollIntoView({ behavior: 'smooth', block: 'center' });
            
            // Автоматический анализ после добавления слова
            this.autoAnalyze();
            
            // Сохраняем состояние
            this.saveState();
            
            console.log('Слово добавлено, но не удалось скопировать в буфер');
        });
    }

    reset() {
        this.rules.reset();
        this.attempts = [];
        document.getElementById('attempts-container').innerHTML = '';
        document.getElementById('results').style.display = 'none';
        this.addNewAttempt();
        
        // Автоматический анализ после сброса (скроет результаты)
        this.autoAnalyze();
        
        // Очищаем сохраненное состояние
        this.clearState();
    }
}

// Инициализация при загрузке страницы
let wordlyHelper;
document.addEventListener('DOMContentLoaded', () => {
    wordlyHelper = new WordlyHelper();
}); 
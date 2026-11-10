'use strict';

/*
 * Движок помощника: чистая логика без DOM.
 *
 * - buildDictionary  готовит словарь: нормализует слова (ё = е), кодирует буквы, расставляет частотные слои;
 * - filterCandidates оставляет слова, не противоречащие отмеченным цветам;
 * - rankGuesses      оценивает каждое слово словаря как следующий ход;
 * - rankLetterChecks подбирает слова, которые лучше всего проверяют невыясненные буквы.
 *
 * Цвета буквы: 'gray' - буквы нет, 'white' - есть, но не на этом месте, 'yellow' - на своём месте.
 */
const WordEngine = (() => {
    const WORD_LENGTH = 5;
    const PATTERN_COUNT = 243; // 3^5 вариантов раскраски

    // Слои: 0 - редкое слово, 1 - известное, 2 - частое.
    // Вес - насколько вероятно, что слово загадано: редкие слова загадывают нечасто.
    const TIER_WEIGHT = [0.08, 0.4, 1];
    // Цена шанса угадать сразу, в битах: подобрана так, чтобы на малых наборах
    // порядок ходов совпадал с порядком по ожидаемому числу попыток.
    const WIN_BONUS = 2;
    // Больше стольких кандидатов не перебираем: берём равномерную выборку.
    const SAMPLE_LIMIT = 1500;
    const SLICE_MS = 12;

    function normalize(word) {
        return String(word).trim().toLowerCase().replace(/ё/g, 'е');
    }

    function splitList(list) {
        if (!list) {
            return [];
        }
        return (Array.isArray(list) ? list : String(list).split(/\s+/)).filter(Boolean);
    }

    function buildDictionary(rawWords, validWord, frequency) {
        const words = [];
        const index = new Map();
        for (const raw of rawWords || []) {
            const word = normalize(raw);
            if (validWord.test(word) && !index.has(word)) {
                index.set(word, words.length);
                words.push(word);
            }
        }

        const letterCodes = new Map();
        const codes = new Uint8Array(words.length * WORD_LENGTH);
        words.forEach((word, i) => {
            for (let k = 0; k < WORD_LENGTH; k++) {
                const letter = word[k];
                if (!letterCodes.has(letter)) {
                    letterCodes.set(letter, letterCodes.size);
                }
                codes[i * WORD_LENGTH + k] = letterCodes.get(letter);
            }
        });

        const hasTiers = Boolean(frequency && (frequency.common || frequency.known));
        const tiers = new Uint8Array(words.length).fill(hasTiers ? 0 : 2);
        if (hasTiers) {
            for (const word of splitList(frequency.known)) {
                const i = index.get(normalize(word));
                if (i !== undefined) {
                    tiers[i] = 1;
                }
            }
            for (const word of splitList(frequency.common)) {
                const i = index.get(normalize(word));
                if (i !== undefined) {
                    tiers[i] = 2;
                }
            }
        }
        const weights = new Float64Array(words.length);
        for (let i = 0; i < words.length; i++) {
            weights[i] = TIER_WEIGHT[tiers[i]];
        }

        return { words, index, codes, tiers, weights, hasTiers, alphabetSize: letterCodes.size };
    }

    // Раскраска догадки guess, если загадано answer: число 0..242,
    // разряд i в троичной записи - цвет буквы i (0 серый, 1 белый, 2 жёлтый).
    function feedback(guess, answer) {
        const left = new Map();
        const marks = new Array(WORD_LENGTH).fill(0);
        for (let i = 0; i < WORD_LENGTH; i++) {
            if (guess[i] === answer[i]) {
                marks[i] = 2;
            } else {
                left.set(answer[i], (left.get(answer[i]) || 0) + 1);
            }
        }
        let pattern = 0;
        let power = 1;
        for (let i = 0; i < WORD_LENGTH; i++) {
            if (marks[i] === 0 && left.get(guess[i]) > 0) {
                marks[i] = 1;
                left.set(guess[i], left.get(guess[i]) - 1);
            }
            pattern += marks[i] * power;
            power *= 3;
        }
        return pattern;
    }

    // Условия одной попытки. Для каждой буквы считаем, сколько раз она отмечена
    // цветной: столько её в слове точно есть. Если та же буква где-то серая,
    // значит, больше её в слове нет. Так повторы букв не дают противоречий.
    function compileAttempt(attempt) {
        const letters = Array.from(normalize(attempt.word));
        const colors = attempt.colors;
        const counts = new Map();
        letters.forEach((letter, i) => {
            const entry = counts.get(letter) || { letter, min: 0, exact: false };
            if (colors[i] === 'gray') {
                entry.exact = true;
            } else {
                entry.min++;
            }
            counts.set(letter, entry);
        });
        return { letters, colors, counts: Array.from(counts.values()) };
    }

    function matchesAttempt(word, compiled) {
        for (let i = 0; i < WORD_LENGTH; i++) {
            const same = word[i] === compiled.letters[i];
            if (compiled.colors[i] === 'yellow' ? !same : same) {
                return false;
            }
        }
        for (const entry of compiled.counts) {
            let count = 0;
            for (let i = 0; i < WORD_LENGTH; i++) {
                if (word[i] === entry.letter) {
                    count++;
                }
            }
            if (count < entry.min || (entry.exact && count > entry.min)) {
                return false;
            }
        }
        return true;
    }

    // Индексы слов словаря, подходящих под все попытки.
    function filterCandidates(dictionary, attempts) {
        const compiled = attempts.map(compileAttempt);
        const result = [];
        dictionary.words.forEach((word, i) => {
            if (compiled.every(attempt => matchesAttempt(word, attempt))) {
                result.push(i);
            }
        });
        return result;
    }

    function pause() {
        return new Promise(resolve => setTimeout(resolve, 0));
    }

    /*
     * Оценивает каждое слово словаря как следующий ход.
     *
     * Ход делит оставшиеся слова на группы по раскраске, которую покажет игра.
     * Чем ровнее и мельче группы, тем больше ход сообщает: это энтропия раскраски
     * (в битах), посчитанная с учётом того, что частые слова загадывают чаще.
     * Если ход сам может быть ответом, добавляем цену шанса угадать сразу.
     * Редкие слова оцениваем, только когда они сами подходят, а советуем (order),
     * только когда выбирать больше не из чего: игра может их не принять.
     *
     * typicalLeft - сколько слов обычно остаётся после хода: среднее геометрическое
     * размера группы, в которую попадёт загаданное слово (total в степени 1 - доля снятой
     * неизвестности). Оно согласовано с порядком ходов: больше бит - меньше остаток.
     *
     * Возвращает null, если расчёт прервали через options.isCancelled.
     */
    async function rankGuesses(dictionary, candidates, options = {}) {
        const { codes, weights, tiers } = dictionary;
        const wordCount = dictionary.words.length;
        const total = candidates.length;

        let sample = candidates;
        if (total > SAMPLE_LIMIT) {
            sample = [];
            const step = total / SAMPLE_LIMIT;
            for (let k = 0; k < SAMPLE_LIMIT; k++) {
                sample.push(candidates[Math.floor(k * step)]);
            }
        }
        const sampleSize = sample.length;

        // Кандидаты в плоском виде: так внутренний цикл обходится без лишних обращений.
        const sampleCodes = new Uint8Array(sampleSize * WORD_LENGTH);
        const sampleWeights = new Float64Array(sampleSize);
        let sampleMass = 0;
        for (let k = 0; k < sampleSize; k++) {
            const offset = sample[k] * WORD_LENGTH;
            for (let j = 0; j < WORD_LENGTH; j++) {
                sampleCodes[k * WORD_LENGTH + j] = codes[offset + j];
            }
            sampleWeights[k] = weights[sample[k]];
            sampleMass += sampleWeights[k];
        }

        let totalMass = 0;
        const isCandidate = new Uint8Array(wordCount);
        for (const i of candidates) {
            isCandidate[i] = 1;
            totalMass += weights[i];
        }

        // Сколько всего неизвестно: столько бит дал бы ход, различающий все слова.
        let maxEntropy = 0;
        for (let k = 0; k < sampleSize; k++) {
            const share = sampleWeights[k] / sampleMass;
            maxEntropy -= share * Math.log2(share);
        }

        const entropy = new Float64Array(wordCount);
        const typicalLeft = new Float64Array(wordCount);
        const winChance = new Float64Array(wordCount);
        const score = new Float64Array(wordCount);

        const groupSize = new Uint16Array(PATTERN_COUNT); // SAMPLE_LIMIT меньше 65536
        const groupMass = new Float64Array(PATTERN_COUNT);
        const letterLeft = new Int8Array(Math.max(64, dictionary.alphabetSize));

        const scored = [];
        let sliceStart = Date.now();
        for (let g = 0; g < wordCount; g++) {
            if ((g & 63) === 0 && Date.now() - sliceStart > SLICE_MS) {
                if (options.onProgress) {
                    options.onProgress(g / wordCount);
                }
                await pause();
                if (options.isCancelled && options.isCancelled()) {
                    return null;
                }
                sliceStart = Date.now();
            }

            if (tiers[g] === 0 && !isCandidate[g]) {
                continue;
            }
            scored.push(g);

            const base = g * WORD_LENGTH;
            const g0 = codes[base], g1 = codes[base + 1], g2 = codes[base + 2],
                g3 = codes[base + 3], g4 = codes[base + 4];
            groupSize.fill(0);
            groupMass.fill(0);

            for (let k = 0, offset = 0; k < sampleSize; k++, offset += WORD_LENGTH) {
                const c0 = sampleCodes[offset], c1 = sampleCodes[offset + 1], c2 = sampleCodes[offset + 2],
                    c3 = sampleCodes[offset + 3], c4 = sampleCodes[offset + 4];
                let pattern = 0;
                if (g0 === c0) { pattern += 2; } else { letterLeft[c0]++; }
                if (g1 === c1) { pattern += 6; } else { letterLeft[c1]++; }
                if (g2 === c2) { pattern += 18; } else { letterLeft[c2]++; }
                if (g3 === c3) { pattern += 54; } else { letterLeft[c3]++; }
                if (g4 === c4) { pattern += 162; } else { letterLeft[c4]++; }
                if (g0 !== c0 && letterLeft[g0] > 0) { pattern += 1; letterLeft[g0]--; }
                if (g1 !== c1 && letterLeft[g1] > 0) { pattern += 3; letterLeft[g1]--; }
                if (g2 !== c2 && letterLeft[g2] > 0) { pattern += 9; letterLeft[g2]--; }
                if (g3 !== c3 && letterLeft[g3] > 0) { pattern += 27; letterLeft[g3]--; }
                if (g4 !== c4 && letterLeft[g4] > 0) { pattern += 81; letterLeft[g4]--; }
                letterLeft[c0] = 0; letterLeft[c1] = 0; letterLeft[c2] = 0; letterLeft[c3] = 0; letterLeft[c4] = 0;
                groupSize[pattern]++;
                groupMass[pattern] += sampleWeights[k];
            }

            let bits = 0;
            for (let p = 0; p < PATTERN_COUNT; p++) {
                if (groupSize[p] > 0) {
                    const share = groupMass[p] / sampleMass;
                    bits -= share * Math.log2(share);
                }
            }
            entropy[g] = bits;
            typicalLeft[g] = maxEntropy > 0 ? Math.pow(total, 1 - Math.min(1, bits / maxEntropy)) : 1;
            winChance[g] = isCandidate[g] ? weights[g] / totalMass : 0;
            score[g] = bits + WIN_BONUS * winChance[g];
        }

        const adviseRare = total <= 2 || candidates.every(i => tiers[i] === 0);
        const order = adviseRare ? scored : scored.filter(g => tiers[g] > 0);
        order.sort((a, b) => score[b] - score[a] || tiers[b] - tiers[a] || a - b);

        return {
            order, score, entropy, typicalLeft, winChance, isCandidate,
            maxEntropy, total, sampled: sampleSize < total
        };
    }

    // Сколько бит даёт ответ на вопрос «есть ли буква в слове», если она есть с вероятностью share.
    function presenceBits(share) {
        if (share <= 0 || share >= 1) {
            return 0;
        }
        return -share * Math.log2(share) - (1 - share) * Math.log2(1 - share);
    }

    /*
     * Подбирает слова, которые лучше всего проверяют буквы.
     *
     * Для каждой буквы считаем долю подходящих слов, где она есть (частые слова весят больше).
     * Проверять стоит буквы, про которые ничего не ясно: доля 0 или 1 ничего не даёт,
     * доля около половины даёт больше всего. Оценка слова - сумма таких бит по его разным буквам.
     * В отличие от rankGuesses, места букв здесь не учитываются: это чистая проверка состава слова.
     *
     * Возвращает shares (буква -> доля), letters (невыясненные буквы по убыванию доли)
     * и moves - лучшие слова с оценкой.
     */
    function rankLetterChecks(dictionary, candidates, limit = 5) {
        const { words, weights, tiers } = dictionary;
        const mass = new Map();
        let totalMass = 0;
        for (const i of candidates) {
            totalMass += weights[i];
            for (const letter of new Set(words[i])) {
                mass.set(letter, (mass.get(letter) || 0) + weights[i]);
            }
        }

        const shares = new Map();
        const value = new Map();
        const letters = [];
        for (const [letter, letterMass] of mass) {
            const share = letterMass / totalMass;
            const bits = presenceBits(share);
            shares.set(letter, share);
            if (bits > 0) {
                value.set(letter, bits);
                letters.push({ letter, share });
            }
        }
        letters.sort((a, b) => b.share - a.share || (a.letter < b.letter ? -1 : 1));

        const isCandidate = new Set(candidates);
        const adviseRare = candidates.every(i => tiers[i] === 0);
        const moves = [];
        words.forEach((word, index) => {
            if (tiers[index] === 0 && !adviseRare) {
                return;
            }
            let score = 0;
            for (const letter of new Set(word)) {
                score += value.get(letter) || 0;
            }
            if (score > 0) {
                moves.push({ index, score, isCandidate: isCandidate.has(index) });
            }
        });
        moves.sort((a, b) => b.score - a.score || b.isCandidate - a.isCandidate ||
            tiers[b.index] - tiers[a.index] || a.index - b.index);

        return { shares, letters, moves: moves.slice(0, limit) };
    }

    return {
        WORD_LENGTH, SAMPLE_LIMIT,
        normalize, buildDictionary, feedback, compileAttempt, matchesAttempt,
        filterCandidates, rankGuesses, rankLetterChecks
    };
})();

if (typeof module !== 'undefined' && module.exports) {
    module.exports = WordEngine;
}

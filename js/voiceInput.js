// js/voiceInput.js
let recognition = null;
let isListening = false;
let sessionCallback = null;
let currentDigits = '';
let statusIndicator = null;

// ---------- МОЩНЫЙ ПАРСЕР (оставлен без изменений) ----------
const STOP_COMMAND_RE = /\b(готово|завершить|заверши|подтвердить|подтверждаю|ввод|стоп|окей|ок)\b/u;

const digitWords = {
    'ноль': '0', 'нуль': '0',
    'один': '1', 'одна': '1', 'одну': '1',
    'два': '2', 'две': '2',
    'три': '3',
    'четыре': '4',
    'пять': '5',
    'шесть': '6',
    'семь': '7',
    'восемь': '8',
    'девять': '9'
};

const unitWords = {
    'мм': 1,
    'миллиметр': 1,
    'миллиметра': 1,
    'миллиметров': 1,
    'см': 10,
    'сантиметр': 10,
    'сантиметра': 10,
    'сантиметров': 10,
    'м': 1000,
    'метр': 1000,
    'метра': 1000,
    'метров': 1000
};

const smallNumberWords = {
    'ноль': 0, 'нуль': 0,
    'один': 1, 'одна': 1, 'одно': 1, 'одну': 1,
    'два': 2, 'две': 2,
    'три': 3,
    'четыре': 4,
    'пять': 5,
    'шесть': 6,
    'семь': 7,
    'восемь': 8,
    'девять': 9,
    'десять': 10,
    'одиннадцать': 11,
    'двенадцать': 12,
    'тринадцать': 13,
    'четырнадцать': 14,
    'пятнадцать': 15,
    'шестнадцать': 16,
    'семнадцать': 17,
    'восемнадцать': 18,
    'девятнадцать': 19
};

const tensWords = {
    'двадцать': 20,
    'тридцать': 30,
    'сорок': 40,
    'пятьдесят': 50,
    'шестьдесят': 60,
    'семьдесят': 70,
    'восемьдесят': 80,
    'девяносто': 90
};

const hundredsWords = {
    'сто': 100,
    'двести': 200,
    'триста': 300,
    'четыреста': 400,
    'пятьсот': 500,
    'шестьсот': 600,
    'семьсот': 700,
    'восемьсот': 800,
    'девятьсот': 900
};

const scaleWords = {
    'тысяча': 1000,
    'тысячи': 1000,
    'тысяч': 1000,
    'миллион': 1000000,
    'миллиона': 1000000,
    'миллионов': 1000000
};

const decimalSeparators = new Set(['запятая', 'точка', 'целых', 'целая', 'целое', 'целые']);

const fillerWords = new Set([
    'и', 'а', 'ну', 'пожалуйста', 'примерно', 'ровно', 'около',
    'длина', 'ширина', 'высота', 'размер', 'значение', 'поставь', 'поставить',
    'введи', 'ввести', 'установи', 'установить', 'сделай', 'нужно', 'надо'
]);

function normalizeSpeech(text) {
    return text
        .toLowerCase()
        .replace(/ё/g, 'е')
        .replace(/[–—-]/g, ' ')
        .replace(/[^0-9a-zа-я.,\s]/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function extractUnitMultiplier(text) {
    const words = text.split(/\s+/).filter(Boolean);
    let unitMultiplier = 1;
    for (const w of words) {
        if (unitWords[w] !== undefined) unitMultiplier = unitWords[w];
    }
    const cleanedWords = words.filter((w) => unitWords[w] === undefined);
    return { unitMultiplier, cleanedText: cleanedWords.join(' ') };
}

function tokenToDigitChunk(token) {
    if (digitWords[token]) return digitWords[token];
    if (/^\d+$/.test(token)) return token;
    return null;
}

function parseDigitSequence(tokens) {
    const useful = tokens.filter((t) => !fillerWords.has(t));
    if (useful.length === 0) return null;
    const chunks = [];
    for (const token of useful) {
        const chunk = tokenToDigitChunk(token);
        if (!chunk) return null;
        chunks.push(chunk);
    }
    if (chunks.length === 0) return null;
    const number = parseInt(chunks.join(''), 10);
    return Number.isNaN(number) ? null : number;
}

function parseNumericToken(raw) {
    let s = raw.replace(/\s+/g, '').trim();
    if (!s) return null;
    if (!/[.,]/.test(s)) {
        const n = Number(s);
        return Number.isFinite(n) ? n : null;
    }
    const dotCount = (s.match(/\./g) || []).length;
    const commaCount = (s.match(/,/g) || []).length;
    if (dotCount > 0 && commaCount > 0) {
        const lastDot = s.lastIndexOf('.');
        const lastComma = s.lastIndexOf(',');
        const decimalSep = lastDot > lastComma ? '.' : ',';
        const thousandsSep = decimalSep === '.' ? ',' : '.';
        s = s.replace(new RegExp(`\\${thousandsSep}`, 'g'), '');
        if (decimalSep === ',') s = s.replace(',', '.');
        const n = Number(s);
        return Number.isFinite(n) ? n : null;
    }
    const sep = dotCount > 0 ? '.' : ',';
    const count = dotCount + commaCount;
    if (count > 1) {
        const parts = s.split(sep);
        const groupsOfThree = parts.slice(1).every((p) => p.length === 3);
        if (groupsOfThree) {
            const n = Number(parts.join(''));
            return Number.isFinite(n) ? n : null;
        }
        const left = parts.slice(0, -1).join('');
        const right = parts[parts.length - 1];
        const n = Number(`${left}.${right}`);
        return Number.isFinite(n) ? n : null;
    }
    const idx = s.indexOf(sep);
    const left = s.slice(0, idx);
    const right = s.slice(idx + 1);
    if (right.length === 3 && left.length >= 1) {
        const n = Number(left + right);
        return Number.isFinite(n) ? n : null;
    }
    const normalized = `${left}.${right}`;
    const n = Number(normalized);
    return Number.isFinite(n) ? n : null;
}

function parseDirectNumbers(text) {
    const matches = text.match(/\d[\d\s.,]*/g);
    if (!matches) return null;
    for (const m of matches) {
        const parsed = parseNumericToken(m);
        if (parsed !== null) return parsed;
    }
    return null;
}

function parseIntegerWords(tokens) {
    let total = 0;
    let current = 0;
    let seenNumeric = false;
    for (const t of tokens) {
        if (!t || fillerWords.has(t)) continue;
        if (smallNumberWords[t] !== undefined) {
            current += smallNumberWords[t];
            seenNumeric = true;
            continue;
        }
        if (tensWords[t] !== undefined) {
            current += tensWords[t];
            seenNumeric = true;
            continue;
        }
        if (hundredsWords[t] !== undefined) {
            current += hundredsWords[t];
            seenNumeric = true;
            continue;
        }
        if (scaleWords[t] !== undefined) {
            if (current === 0) current = 1;
            total += current * scaleWords[t];
            current = 0;
            seenNumeric = true;
            continue;
        }
        if (/^\d+$/.test(t)) {
            current += parseInt(t, 10);
            seenNumeric = true;
            continue;
        }
        return null;
    }
    if (!seenNumeric) return null;
    return total + current;
}

function parseFractionTokens(tokens) {
    const compact = tokens.filter((t) => !fillerWords.has(t));
    if (compact.length === 0) return null;
    const asDigits = [];
    let allDigitLike = true;
    for (const t of compact) {
        const d = tokenToDigitChunk(t);
        if (d === null) {
            allDigitLike = false;
            break;
        }
        asDigits.push(d);
    }
    if (allDigitLike) {
        const joined = asDigits.join('');
        if (/^\d+$/.test(joined)) return Number(`0.${joined}`);
    }
    const asInt = parseIntegerWords(compact);
    if (asInt !== null) {
        const digitsCount = String(Math.trunc(Math.abs(asInt))).length;
        return asInt / Math.pow(10, digitsCount);
    }
    return null;
}

function parseWordNumber(text) {
    const tokens = text.split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return null;
    if (tokens.includes('полтора') || tokens.includes('полторы')) return 1.5;
    if (tokens.length === 1 && (tokens[0] === 'пол' || tokens[0] === 'половина')) return 0.5;
    const halfIdx = tokens.indexOf('половиной');
    if (halfIdx > 0) {
        const leftTokens = tokens.slice(0, halfIdx).filter((t) => t !== 'с');
        const left = parseIntegerWords(leftTokens);
        if (left !== null) return left + 0.5;
    }
    const sepIdx = tokens.findIndex((t) => decimalSeparators.has(t));
    if (sepIdx > 0) {
        const intPart = parseIntegerWords(tokens.slice(0, sepIdx));
        const fracPart = parseFractionTokens(tokens.slice(sepIdx + 1));
        if (intPart !== null && fracPart !== null) return intPart + fracPart;
    }
    return parseIntegerWords(tokens);
}

function parseAnyLength(text) {
    const original = String(text || '');
    const normalized = normalizeSpeech(original);
    if (!normalized) return null;
    const { unitMultiplier, cleanedText } = extractUnitMultiplier(normalized);

    // 1) Последовательность цифр: "3 2 1", "три два один"
    const digitSequence = parseDigitSequence(cleanedText.split(/\s+/).filter(Boolean));
    if (digitSequence !== null) {
        return Math.round(digitSequence * unitMultiplier);
    }

    // 2) Прямые числа: 321, 50 000, 5.5, 5,5
    const direct = parseDirectNumbers(cleanedText);
    if (direct !== null) {
        return Math.round(direct * unitMultiplier);
    }

    // 3) Словами: "пятьдесят тысяч", "триста двадцать один", "полтора"
    const byWords = parseWordNumber(cleanedText);
    if (byWords !== null) {
        return Math.round(byWords * unitMultiplier);
    }

    // 4) Fallback: все цифры подряд из оригинала
    const digits = original.replace(/\D/g, '');
    if (digits) {
        const num = parseInt(digits, 10);
        if (!Number.isNaN(num)) {
            return Math.round(num * unitMultiplier);
        }
    }
    return null;
}

// ---------- ИНДИКАТОР В СТАТУСБАРЕ ----------
function showIndicator(text) {
    if (!statusIndicator) {
        const st = document.querySelector('.statusbar');
        if (st) {
            statusIndicator = document.createElement('span');
            statusIndicator.id = 'voiceIndicator';
            statusIndicator.style.cssText = 'margin-left:12px;color:#4a6fe3;font-weight:500;';
            st.appendChild(statusIndicator);
        }
    }
    if (statusIndicator) statusIndicator.textContent = text || '🎤';
}

function hideIndicator() {
    if (statusIndicator) statusIndicator.textContent = '';
}

// ---------- ОСНОВНОЙ МОДУЛЬ (БЫСТРЫЙ) ----------
export const VoiceInput = {
    init() {
        if (!('SpeechRecognition' in window) && !('webkitSpeechRecognition' in window)) {
            console.warn('ℹ️ SpeechRecognition не поддерживается.');
            return;
        }

        recognition = new (window.SpeechRecognition || window.webkitSpeechRecognition)();
        recognition.lang = 'ru-RU';
        recognition.interimResults = true;
        recognition.maxAlternatives = 1;
        recognition.continuous = true;

        recognition.onresult = (event) => {
            if (!sessionCallback) return;
            const last = event.results[event.results.length - 1];
            const transcript = last[0].transcript.trim().toLowerCase();

            console.log(`🎤 ${transcript}`);

            if (STOP_COMMAND_RE.test(transcript)) {
                // По команде "готово" можно сразу завершить, но у нас управление по отпусканию пробела
                return;
            }

            const parsed = parseAnyLength(transcript);
            if (parsed !== null) {
                currentDigits = parsed.toString();
                showIndicator(`${currentDigits} мм`);
                sessionCallback(parsed, false);
                return;
            }

            // Накопление по отдельным цифрам
            const words = normalizeSpeech(transcript).split(/\s+/).filter(Boolean);
            let added = false;
            for (const w of words) {
                if (digitWords[w]) {
                    currentDigits += digitWords[w];
                    added = true;
                }
            }
            if (added) {
                const num = parseInt(currentDigits, 10);
                if (!Number.isNaN(num)) {
                    showIndicator(`${currentDigits} мм`);
                    sessionCallback(num, false);
                }
            }
        };

        recognition.onerror = (e) => {
            console.error('Voice error:', e);
            isListening = false;
            hideIndicator();
        };

        recognition.onend = () => {
            isListening = false;
            hideIndicator();
        };

        console.log('✅ VoiceInput (быстрый режим) готов');
    },

    startListening(callback) {
        if (!recognition || isListening) return;
        sessionCallback = callback;
        currentDigits = '';
        isListening = true;
        showIndicator('🎤');
        recognition.start();
    },

    stopListening() {
        if (!recognition || !isListening) return;
        const finalNumber = currentDigits.length > 0 ? parseInt(currentDigits, 10) : null;
        if (sessionCallback) {
            sessionCallback(finalNumber, true);
            sessionCallback = null;
        }
        recognition.stop();
        currentDigits = '';
        hideIndicator();
    },

    abort() {
        if (recognition && isListening) {
            recognition.stop();
            sessionCallback = null;
            currentDigits = '';
            hideIndicator();
        }
    }
};

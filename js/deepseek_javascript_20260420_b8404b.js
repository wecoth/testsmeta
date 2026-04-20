// js/voiceInput.js
import { EventBus } from './eventBus.js';

let recognition = null;
let isListening = false;
let currentCallback = null;
let overlayElement = null;
let holdKey = 'Space'; // Можно будет вынести в настройки

// Словарь для парсинга русских числительных
const numberWords = {
    'ноль': 0, 'один': 1, 'одна': 1, 'два': 2, 'две': 2, 'три': 3, 'четыре': 4,
    'пять': 5, 'шесть': 6, 'семь': 7, 'восемь': 8, 'девять': 9, 'десять': 10,
    'одиннадцать': 11, 'двенадцать': 12, 'тринадцать': 13, 'четырнадцать': 14,
    'пятнадцать': 15, 'шестнадцать': 16, 'семнадцать': 17, 'восемнадцать': 18,
    'девятнадцать': 19, 'двадцать': 20, 'тридцать': 30, 'сорок': 40,
    'пятьдесят': 50, 'шестьдесят': 60, 'семьдесят': 70, 'восемьдесят': 80,
    'девяносто': 90, 'сто': 100, 'двести': 200, 'триста': 300, 'четыреста': 400,
    'пятьсот': 500, 'шестьсот': 600, 'семьсот': 700, 'восемьсот': 800, 'девятьсот': 900,
    'тысяча': 1000, 'тысячи': 1000, 'тысяч': 1000
};

function parseSpokenLength(text) {
    let str = text.toLowerCase().trim()
        .replace(/метров|метра|метр|м/gi, ' ')
        .replace(/сантиметров|сантиметра|сантиметр|см/gi, ' ')
        .replace(/миллиметров|миллиметр|мм/gi, '')
        .replace(/с половиной/gi, '.5')
        .replace(/целых|и|запятая|точка/gi, '.')
        .replace(/\s+/g, ' ');

    // Прямое числовое значение (например "4800", "4.8", "3.25")
    let num = parseFloat(str);
    if (!isNaN(num)) {
        // Если число маленькое, вероятно это метры (например 4.8 -> 4800 мм)
        if (num < 100) num *= 1000;
        return Math.round(num);
    }

    // Парсинг слов
    let result = 0;
    let current = 0;
    const words = str.split(' ');

    for (let word of words) {
        if (numberWords[word] !== undefined) {
            if (word === 'тысяча' || word === 'тысячи' || word === 'тысяч') {
                result += (current || 1) * 1000;
                current = 0;
            } else {
                current += numberWords[word];
            }
        } else if (/^\d+$/.test(word)) {
            current = parseInt(word);
        }
    }
    result += current;

    // Если результат 0, но в строке были цифры
    if (result === 0 && str.match(/\d/)) {
        result = parseFloat(str.replace(/[^\d.]/g, '')) || 0;
    }

    // Разумные пределы для длины стены (100 - 20000 мм)
    return (result >= 100 && result <= 20000) ? Math.round(result) : null;
}

function showOverlay() {
    if (!overlayElement) {
        overlayElement = document.createElement('div');
        overlayElement.id = 'voice-overlay';
        overlayElement.innerHTML = `
            <div class="voice-modal">
                <div class="mic-icon">🎤</div>
                <div class="voice-text">Слушаю...</div>
                <div class="voice-hint">Скажите длину стены<br>(например: «четыре метра восемьдесят»)</div>
            </div>
        `;
        document.body.appendChild(overlayElement);
    }
    overlayElement.classList.add('active');
}

function hideOverlay() {
    if (overlayElement) overlayElement.classList.remove('active');
}

export const VoiceInput = {
    init() {
        if (!('SpeechRecognition' in window) && !('webkitSpeechRecognition' in window)) {
            console.warn('❌ SpeechRecognition не поддерживается');
            return;
        }

        recognition = new (window.SpeechRecognition || window.webkitSpeechRecognition)();
        recognition.lang = 'ru-RU';
        recognition.interimResults = false;
        recognition.maxAlternatives = 1;

        recognition.onresult = (event) => {
            const text = event.results[0][0].transcript;
            console.log('🎤 Распознано:', text);

            const mm = parseSpokenLength(text);
            if (mm && currentCallback) {
                currentCallback(mm);
            } else {
                console.warn('⚠️ Не удалось распарсить длину из:', text);
            }
        };

        recognition.onerror = (e) => {
            console.error('Voice error:', e);
            isListening = false;
            hideOverlay();
        };

        recognition.onend = () => {
            isListening = false;
            hideOverlay();
        };

        console.log('✅ VoiceInput готов (зажмите Space для голосового ввода длины)');
    },

    startListening(callback) {
        if (!recognition || isListening) return;
        currentCallback = callback;
        isListening = true;
        showOverlay();
        recognition.start();
    },

    stopListening() {
        if (recognition && isListening) {
            recognition.stop();
        }
        // Оверлей скроется в onend
    },

    isListening() {
        return isListening;
    }
};
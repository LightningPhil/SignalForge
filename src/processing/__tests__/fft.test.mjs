import { FFT } from '../fft.js';

function assert(condition, message) {
    if (!condition) throw new Error(message || 'Assertion failed');
}

function allFinite(arr) {
    return Array.from(arr).every((v) => Number.isFinite(v));
}

function testNextPowerOfTwo() {
    assert(FFT.nextPowerOfTwo(0) === 1, 'nextPowerOfTwo(0)');
    assert(FFT.nextPowerOfTwo(1) === 1, 'nextPowerOfTwo(1)');
    assert(FFT.nextPowerOfTwo(2) === 2, 'nextPowerOfTwo(2)');
    assert(FFT.nextPowerOfTwo(3) === 4, 'nextPowerOfTwo(3)');
}

function testWindowsLengthOne() {
    ['hann', 'hamming'].forEach((type) => {
        const { window, coherentGain, enbw } = FFT.getWindow(type, 1);
        assert(window.length === 1, `${type} window length`);
        assert(window[0] === 1, `${type} window value`);
        assert(coherentGain === 1, `${type} coherent gain`);
        assert(enbw === 1, `${type} enbw`);
        assert(allFinite(window), `${type} window finite`);
    });
}

function testEmptySpectrum() {
    const spectrum = FFT.computeSpectrum([]);
    assert(Array.isArray(spectrum.freq) && spectrum.freq.length === 0, 'empty freq array');
    assert(Array.isArray(spectrum.magnitude) && spectrum.magnitude.length === 0, 'empty magnitude array');
    assert(allFinite(spectrum.re || []) && allFinite(spectrum.im || []), 'empty re/im finite');
}

function testSingleSampleSpectrum() {
    const spectrum = FFT.computeSpectrum([1], [0]);
    assert(allFinite(spectrum.magnitude), 'single sample magnitude finite');
    assert(allFinite(spectrum.linearMagnitude), 'single sample linear magnitude finite');
    assert(allFinite(spectrum.phase), 'single sample phase finite');
}

function run() {
    testNextPowerOfTwo();
    testWindowsLengthOne();
    testEmptySpectrum();
    testSingleSampleSpectrum();
    console.log('All FFT tests passed');
}

try {
    run();
} catch (err) {
    console.error(err.message || err);
    process.exit(1);
}

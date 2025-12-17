import { Filter } from '../filter.js';

function assert(condition, message) {
    if (!condition) throw new Error(message || 'Assertion failed');
}

function allFinite(arr) {
    return Array.from(arr).every((v) => Number.isFinite(v));
}

function testInvalidSavgolThrows() {
    let threw = false;
    try {
        Filter.savitzkyGolay([1, 2, 3], 3, 4);
    } catch (err) {
        threw = true;
    }
    assert(threw, 'Expected savitzkyGolay to throw for invalid config');
}

function testSavgolCoefficientsFinite() {
    const result = Filter.savitzkyGolay([1, 2, 3, 4, 5], 5, 2);
    assert(allFinite(result), 'Savitzky-Golay output must be finite');
}

function testCutoffNormalization() {
    const transfer = Filter.calculateTransferFunction([
        { enabled: true, type: 'highPassFFT', cutoffFreq: 0 }
    ], 1000, 8);
    assert(allFinite(transfer), 'Transfer function should be finite for fc=0');
    assert(transfer[0] === 0, 'High-pass gain at DC should be zero');
}

function run() {
    testInvalidSavgolThrows();
    testSavgolCoefficientsFinite();
    testCutoffNormalization();
    console.log('All filter tests passed');
}

try {
    run();
} catch (err) {
    console.error(err.message || err);
    process.exit(1);
}

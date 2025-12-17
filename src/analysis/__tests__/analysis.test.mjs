import { FFT } from '../../processing/fft.js';
import { Measurements } from '../measurements.js';
import { EventDetector } from '../eventDetector.js';
import { CrossChannel } from '../crossChannel.js';

function assert(condition, message) {
    if (!condition) {
        throw new Error(message || 'Assertion failed');
    }
}

function approxEqual(a, b, tol = 1e-6) {
    return Math.abs(a - b) <= tol;
}

function testFFTCoherentGain() {
    const hann = FFT.getWindow('hann', 1024);
    const rect = FFT.getWindow('rectangular', 1024);
    assert(hann.coherentGain > 0.43 && hann.coherentGain < 0.51, `Hann coherent gain unexpected: ${hann.coherentGain}`);
    assert(approxEqual(rect.coherentGain, 1, 1e-6), `Rectangular coherent gain unexpected: ${rect.coherentGain}`);
}

function testRiseTimeMeasurement() {
    const t = Array.from({ length: 50 }, (_, i) => i * 1e-4);
    const y = t.map((_, i) => {
        if (i < 10) return 0;
        if (i > 30) return 1;
        return (i - 10) / 20;
    });
    const result = Measurements.compute({ t, y });
    const expectedRise = 0.0016; // 16 samples at 1e-4 s from 10% to 90%
    assert(Math.abs(result.metrics.riseTime - expectedRise) < 5e-4, `Rise time off: ${result.metrics.riseTime}`);
    assert(result.warnings.length === 0, 'Unexpected warnings for uniform timebase');
}

function testPulseTriggerDetection() {
    const t = Array.from({ length: 200 }, (_, i) => i * 1e-3);
    const y = t.map((_, i) => {
        if ((i > 20 && i < 25) || (i > 100 && i < 107)) return 1;
        return 0;
    });
    const { events } = EventDetector.detect({
        t,
        y,
        config: { type: 'pulse', threshold: 0.5, minWidth: 0.003, maxWidth: 0.008 }
    });
    assert(events.length === 2, `Expected 2 pulses, found ${events.length}`);
}

function testDelayEstimation() {
    const fs = 1000;
    const delaySeconds = 0.01;
    const samples = 1000;
    const t = Array.from({ length: samples }, (_, i) => i / fs);
    const x = t.map((time) => Math.sin(2 * Math.PI * 10 * time));
    const y = t.map((time) => Math.sin(2 * Math.PI * 10 * (time - delaySeconds)));
    const { delay, correlation } = CrossChannel.estimateDelay(t, x, y, { maxLagSeconds: 0.05 });
    assert(Math.abs(delay - delaySeconds) < 1e-3, `Delay estimate mismatch: ${delay}`);
    assert(correlation > 0.9, `Correlation too low: ${correlation}`);
}

function run() {
    testFFTCoherentGain();
    testRiseTimeMeasurement();
    testPulseTriggerDetection();
    testDelayEstimation();
    console.log('All analysis tests passed');
}

try {
    run();
} catch (err) {
    console.error(err.message || err);
    process.exit(1);
}

import { EventDetector } from '../eventDetector.js';

function assert(condition, message) {
    if (!condition) throw new Error(message || 'Assertion failed');
}

function testPairedFilteringAlignment() {
    const t = [0, 1, 2, 3];
    const y = [10, NaN, 12, 13];
    const { events } = EventDetector.detect({
        t,
        y,
        config: { type: 'level', threshold: 11, direction: 'rising' }
    });
    assert(events.length === 1, `Expected 1 event, found ${events.length}`);
    assert(events[0].time === 2, `Expected event time 2, got ${events[0].time}`);
}

function testTooShortSignals() {
    const { events } = EventDetector.detect({ t: [0], y: [1], config: { type: 'level', threshold: 0.5 } });
    assert(events.length === 0, 'Too-short signals should not produce events');
}

function run() {
    testPairedFilteringAlignment();
    testTooShortSignals();
    console.log('All event detector tests passed');
}

try {
    run();
} catch (err) {
    console.error(err.message || err);
    process.exit(1);
}

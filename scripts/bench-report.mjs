import { analyticByteBudget } from '../tests/synthetic/lab.ts';

const sampleArgument = process.argv.find((argument) => argument.startsWith('--samples='));
const channelArgument = process.argv.find((argument) => argument.startsWith('--channels='));
const sampleCounts = sampleArgument
  ? sampleArgument.slice('--samples='.length).split(',').map(Number)
  : [100_000, 1_000_000];
const channelCount = channelArgument ? Number(channelArgument.slice('--channels='.length)) : 1;

if (
  sampleCounts.some((value) => !Number.isSafeInteger(value) || value < 0) ||
  !Number.isSafeInteger(channelCount) ||
  channelCount < 0
) {
  throw new Error('Use non-negative integers for --samples and --channels.');
}

const budgets = sampleCounts.map((sampleCount) => {
  const bytes = analyticByteBudget(sampleCount, channelCount);
  return {
    ...bytes,
    totalMiB: Number((bytes.totalBytes / 1024 ** 2).toFixed(3))
  };
});

console.log(
  JSON.stringify(
    {
      scope: 'Typed-array payload only; production algorithm temporaries are intentionally excluded.',
      bytesPerElement: {
        time: Float64Array.BYTES_PER_ELEMENT,
        value: Float64Array.BYTES_PER_ELEMENT,
        quality: Uint16Array.BYTES_PER_ELEMENT
      },
      budgets,
      testCommands: {
        ordinaryCi: 'npx vitest run tests/bench/scale-100k.test.ts',
        millionSamplePosix: 'SIGNALFORGE_LAB_1M=1 npx vitest run tests/bench/scale-1m.test.ts',
        millionSamplePowerShell: "$env:SIGNALFORGE_LAB_1M='1'; npx vitest run tests/bench/scale-1m.test.ts"
      }
    },
    null,
    2
  )
);

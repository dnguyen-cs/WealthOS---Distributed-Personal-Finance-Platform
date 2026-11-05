import { afterEach, describe, expect, it } from 'vitest';

import { enhancedFanOut, isStreamMapping } from '@/lib/pulse/stream';

const STREAM = 'arn:aws:kinesis:us-east-1:123456789012:stream/pulse-events';

describe('isStreamMapping', () => {
  it('matches a standard mapping on the stream itself', () => {
    expect(isStreamMapping(STREAM, STREAM)).toBe(true);
  });

  it('matches an enhanced fan-out mapping on one of the stream consumers', () => {
    expect(isStreamMapping(`${STREAM}/consumer/pulse-consumer:1793867000`, STREAM)).toBe(true);
  });

  it('does not match a different stream that shares the name as a prefix', () => {
    const other = 'arn:aws:kinesis:us-east-1:123456789012:stream/pulse-events-old';
    expect(isStreamMapping(other, STREAM)).toBe(false);
    expect(isStreamMapping(`${other}/consumer/pulse-consumer:1793867000`, STREAM)).toBe(false);
  });

  it('does not match a mapping on some other event source', () => {
    expect(isStreamMapping('arn:aws:sqs:us-east-1:123456789012:wealthsim-demo-node', STREAM)).toBe(
      false,
    );
    expect(isStreamMapping(undefined, STREAM)).toBe(false);
  });
});

describe('enhancedFanOut', () => {
  const original = process.env.PULSE_ENHANCED_FAN_OUT;
  afterEach(() => {
    if (original === undefined) delete process.env.PULSE_ENHANCED_FAN_OUT;
    else process.env.PULSE_ENHANCED_FAN_OUT = original;
  });

  it('is on unless explicitly opted out', () => {
    delete process.env.PULSE_ENHANCED_FAN_OUT;
    expect(enhancedFanOut()).toBe(true);
    process.env.PULSE_ENHANCED_FAN_OUT = '1';
    expect(enhancedFanOut()).toBe(true);
    process.env.PULSE_ENHANCED_FAN_OUT = '0';
    expect(enhancedFanOut()).toBe(false);
  });
});

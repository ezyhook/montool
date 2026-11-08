// Small runtime helpers that behave the same on Node and Bun.

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const PRODUCTS: Record<string, { name: string; basePrice: number }> = {
  AAPL: { name: 'Apple Inc.', basePrice: 185.0 },
  TSLA: { name: 'Tesla Inc.', basePrice: 245.0 },
  NVDA: { name: 'NVIDIA Corp.', basePrice: 875.0 },
};

function randomBetween(min: number, max: number) {
  return Math.random() * (max - min) + min;
}

export function randomDelay() {
  return Math.floor(randomBetween(300, 1000));
}

export function mockTickerPayload(symbol: string) {
  const product = PRODUCTS[symbol] ?? { name: symbol, basePrice: 100 };
  const change = randomBetween(-3, 3);
  const price = +(product.basePrice + randomBetween(-10, 10)).toFixed(2);
  return {
    symbol,
    name: product.name,
    price,
    change: +change.toFixed(2),
    changePercent: +((change / product.basePrice) * 100).toFixed(4),
  };
}

export function mockTradePayload(symbol: string) {
  const product = PRODUCTS[symbol] ?? { name: symbol, basePrice: 100 };
  const price = +(product.basePrice + randomBetween(-10, 10)).toFixed(2);
  const quantity = Math.floor(randomBetween(1, 500));
  const side = Math.random() > 0.5 ? 'buy' : 'sell';
  return {
    symbol,
    price,
    quantity,
    side,
    total: +(price * quantity).toFixed(2),
  };
}

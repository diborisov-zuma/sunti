/**
 * Parser registry.
 * Each parser exports { parse(fileBuffer) → { lines, period_from, period_to, opening_balance, closing_balance } }
 * To add a new bank: create <bank_key>.js, register here.
 */

const parsers = {
  bangkok_bank: require('./bangkok_bank'),
};

function getParser(bankFormat) {
  const p = parsers[bankFormat];
  if (!p) throw new Error(`Unknown bank format: "${bankFormat}". Available: ${Object.keys(parsers).join(', ')}`);
  return p;
}

module.exports = { getParser, availableFormats: Object.keys(parsers) };

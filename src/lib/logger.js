'use strict';

const logger = {
  error: (...args) => console.error(...args),
  warn:  (...args) => console.warn(...args),
  info:  (...args) => console.log(...args),
};

module.exports = logger;

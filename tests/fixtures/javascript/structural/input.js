const filesystem = require("node:fs");

class Worker {
  run(value = "hidden") {
    const normalize = (input) => input.trim();
    return normalize(value);
  }
}

const makeWorker = () => new Worker();

module.exports = Worker;
exports.makeWorker = makeWorker;

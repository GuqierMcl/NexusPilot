const ansi = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
};

function shouldUseColor() {
  return !process.env.NO_COLOR;
}

export function createStyle({ color = shouldUseColor() } = {}) {
  const wrap = (code, value) => {
    if (!color) {
      return value;
    }

    return `${code}${value}${ansi.reset}`;
  };

  return {
    bold: (value) => wrap(ansi.bold, value),
    dim: (value) => wrap(ansi.dim, value),
    red: (value) => wrap(ansi.red, value),
    green: (value) => wrap(ansi.green, value),
    yellow: (value) => wrap(ansi.yellow, value),
    cyan: (value) => wrap(ansi.cyan, value),
  };
}

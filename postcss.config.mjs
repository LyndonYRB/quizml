import path from "node:path";

const projectRoot = path.resolve(process.cwd());

const config = {
  plugins: {
    "@tailwindcss/postcss": {
      base: projectRoot,
    },
  },
};

export default config;

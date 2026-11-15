import { defineConfig } from "vite";

// base "./": il sito funziona anche in una sottocartella su Aruba
export default defineConfig({
  base: "./",
  build: {
    target: "es2020",
  },
});

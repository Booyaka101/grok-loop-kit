import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    langgraph: 'src/langgraph.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  // LangChain is an optional peer; never bundle it into our output.
  external: ['@langchain/core', '@langchain/openai', '@langchain/langgraph'],
  outExtension({ format }) {
    return { js: format === 'cjs' ? '.cjs' : '.js' };
  },
});

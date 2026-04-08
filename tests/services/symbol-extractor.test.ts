import { describe, it, expect, beforeAll } from 'vitest';
import { SymbolExtractor } from '../../src/services/symbol-extractor.js';

describe('SymbolExtractor', () => {
  let extractor: SymbolExtractor;

  beforeAll(async () => {
    extractor = new SymbolExtractor();
    await extractor.init();
  });

  describe('Ruby', () => {
    it('extracts class definition', async () => {
      const code = `class UserService\n  def authenticate(email, password)\n    nil\n  end\nend`;
      const symbols = await extractor.extractSymbols(code, 'ruby', 'app/services/user_service.rb');
      const cls = symbols.find(s => s.symbolType === 'class');
      expect(cls).toBeDefined();
      expect(cls!.symbolName).toBe('UserService');
    });

    it('extracts method with qualified name', async () => {
      const code = `class UserService\n  def authenticate(email, password)\n    nil\n  end\nend`;
      const symbols = await extractor.extractSymbols(code, 'ruby', 'app/services/user_service.rb');
      const method = symbols.find(s => s.symbolName === 'UserService#authenticate');
      expect(method).toBeDefined();
      expect(method!.symbolType).toBe('method');
      expect(method!.content).toContain('def authenticate');
    });

    it('extracts module', async () => {
      const code = `module TagsV2\n  class DataMapper\n  end\nend`;
      const symbols = await extractor.extractSymbols(code, 'ruby', 'app/services/tags_v2/data_mapper.rb');
      const mod = symbols.find(s => s.symbolType === 'module');
      expect(mod).toBeDefined();
      expect(mod!.symbolName).toBe('TagsV2');
    });

    it('enriches embedText with file path and language', async () => {
      const code = `class Greeter\n  def hello\n    "hi"\n  end\nend`;
      const symbols = await extractor.extractSymbols(code, 'ruby', 'app/services/greeter.rb');
      const method = symbols.find(s => s.symbolName === 'Greeter#hello');
      expect(method!.embedText).toContain('Ruby');
      expect(method!.embedText).toContain('app/services/greeter.rb');
      expect(method!.embedText).toContain('Greeter#hello');
    });
  });

  describe('TypeScript', () => {
    it('extracts exported function', async () => {
      const code = `export function useDataLayer(descriptor: any): any {\n  return {};\n}`;
      const symbols = await extractor.extractSymbols(code, 'typescript', 'src/hooks/use-data-layer.ts');
      expect(symbols).toHaveLength(1);
      expect(symbols[0].symbolName).toBe('useDataLayer');
      expect(symbols[0].symbolType).toBe('function');
    });

    it('extracts interface', async () => {
      const code = `export interface DataLayerDescriptor {\n  pointIds: string[];\n  startTime: Date;\n}`;
      const symbols = await extractor.extractSymbols(code, 'typescript', 'src/types.ts');
      expect(symbols).toHaveLength(1);
      expect(symbols[0].symbolName).toBe('DataLayerDescriptor');
      expect(symbols[0].symbolType).toBe('interface');
    });

    it('extracts class and its methods', async () => {
      const code = `export class ApiClient {\n  async fetch(path: string): Promise<Response> {\n    return fetch(path);\n  }\n}`;
      const symbols = await extractor.extractSymbols(code, 'typescript', 'src/api-client.ts');
      const cls = symbols.find(s => s.symbolType === 'class');
      expect(cls).toBeDefined();
      expect(cls!.symbolName).toBe('ApiClient');
    });

    it('enriches embedText for TypeScript', async () => {
      const code = `export function useDataLayer(): any { return {}; }`;
      const symbols = await extractor.extractSymbols(code, 'typescript', 'src/hooks/use-data-layer.ts');
      expect(symbols[0].embedText).toContain('TypeScript');
      expect(symbols[0].embedText).toContain('src/hooks/use-data-layer.ts');
      expect(symbols[0].embedText).toContain('useDataLayer');
    });
  });

  describe('TSX', () => {
    it('extracts React component arrow function', async () => {
      const code = `export const TimeChart = ({ config }: Props) => {\n  return <div />;\n};`;
      const symbols = await extractor.extractSymbols(code, 'tsx', 'src/components/time-chart.tsx');
      expect(symbols.length).toBeGreaterThan(0);
      const comp = symbols.find(s => s.symbolName === 'TimeChart');
      expect(comp).toBeDefined();
    });
  });

  describe('fallback chunking', () => {
    it('chunks unsupported languages into windows', async () => {
      const lines = Array.from({ length: 150 }, (_, i) => `line ${i + 1}`);
      const code = lines.join('\n');
      const symbols = await extractor.extractSymbols(code, 'json', 'config/settings.json');
      expect(symbols.length).toBeGreaterThan(0);
      symbols.forEach(s => expect(s.symbolType).toBe('chunk'));
    });

    it('chunks Ruby files with no extractable symbols', async () => {
      const code = Array.from({ length: 120 }, (_, i) => `# comment ${i}`).join('\n');
      const symbols = await extractor.extractSymbols(code, 'ruby', 'config/initializers/foo.rb');
      // Should fall back to chunk mode if no symbols found
      expect(symbols.length).toBeGreaterThan(0);
    });
  });

  describe('line numbers', () => {
    it('records correct line_start and line_end', async () => {
      const code = `class Foo\n  def bar\n    1\n  end\nend`;
      const symbols = await extractor.extractSymbols(code, 'ruby', 'app/models/foo.rb');
      const method = symbols.find(s => s.symbolName === 'Foo#bar');
      expect(method!.lineStart).toBeGreaterThan(0);
      expect(method!.lineEnd).toBeGreaterThanOrEqual(method!.lineStart);
    });
  });
});

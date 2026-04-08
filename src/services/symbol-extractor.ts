// web-tree-sitter has inconsistent TypeScript types in ESM — use dynamic import with any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyNode = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyParser = any;

import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Use createRequire for web-tree-sitter in ESM context to avoid type issues
import { createRequire } from 'module';
const _require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { Parser, Language }: any = _require('web-tree-sitter');

export interface ExtractedSymbol {
  symbolName: string;
  symbolType: string;
  lineStart: number;
  lineEnd: number;
  content: string;
  embedText: string;
}

type SupportedLanguage = 'ruby' | 'typescript' | 'tsx';

const GRAMMAR_FILES: Record<SupportedLanguage, string> = {
  ruby: 'tree-sitter-ruby.wasm',
  typescript: 'tree-sitter-typescript.wasm',
  tsx: 'tree-sitter-tsx.wasm',
};

export class SymbolExtractor {
  private parsers = new Map<string, AnyParser>();
  private initialized = false;

  async init(): Promise<void> {
    if (this.initialized) return;

    await Parser.init({
      locateFile: () =>
        path.resolve(__dirname, '../../src/grammars/tree-sitter.wasm'),
    });

    for (const [lang, file] of Object.entries(GRAMMAR_FILES) as [SupportedLanguage, string][]) {
      const grammarPath = path.resolve(__dirname, '../../src/grammars', file);
      const language = await Language.load(grammarPath);
      const parser = new Parser();
      parser.setLanguage(language);
      this.parsers.set(lang, parser);
    }

    this.initialized = true;
  }

  async extractSymbols(
    code: string,
    language: string,
    filePath: string,
  ): Promise<ExtractedSymbol[]> {
    const lang = language.toLowerCase() as SupportedLanguage;
    const parser = this.parsers.get(lang);

    if (!parser) {
      return this.windowChunk(code, filePath, language);
    }

    const tree = parser.parse(code);
    let symbols: ExtractedSymbol[] = [];

    if (lang === 'ruby') {
      symbols = this.extractRubySymbols(tree, code, filePath);
    } else if (lang === 'typescript' || lang === 'tsx') {
      symbols = this.extractTypeScriptSymbols(tree, code, filePath, language);
    }

    // Fall back to chunking if no symbols found
    if (symbols.length === 0) {
      return this.windowChunk(code, filePath, language);
    }

    return symbols;
  }

  private extractRubySymbols(
    tree: AnyNode,
    code: string,
    filePath: string,
  ): ExtractedSymbol[] {
    const symbols: ExtractedSymbol[] = [];
    const lines = code.split('\n');

    const visit = (node: AnyNode, containerStack: string[]) => {
      if (node.type === 'class') {
        const nameNode = node.childForFieldName('name') ?? node.children.find((c: AnyNode) => c.type === 'constant');
        const name = nameNode?.text ?? 'UnknownClass';
        const lineStart = node.startPosition.row + 1;
        const lineEnd = node.endPosition.row + 1;
        const content = lines.slice(lineStart - 1, lineEnd).join('\n');
        const firstLine = lines[lineStart - 1] ?? '';

        symbols.push({
          symbolName: name,
          symbolType: 'class',
          lineStart,
          lineEnd,
          content,
          embedText: this.buildEmbedText('Ruby', 'class', filePath, name, firstLine),
        });

        // Visit children with this class on the stack
        for (const child of node.children) {
          visit(child, [...containerStack, name]);
        }
        return;
      }

      if (node.type === 'module') {
        const nameNode = node.childForFieldName('name') ?? node.children.find((c: AnyNode) => c.type === 'constant');
        const name = nameNode?.text ?? 'UnknownModule';
        const lineStart = node.startPosition.row + 1;
        const lineEnd = node.endPosition.row + 1;
        const content = lines.slice(lineStart - 1, lineEnd).join('\n');
        const firstLine = lines[lineStart - 1] ?? '';

        symbols.push({
          symbolName: name,
          symbolType: 'module',
          lineStart,
          lineEnd,
          content,
          embedText: this.buildEmbedText('Ruby', 'module', filePath, name, firstLine),
        });

        for (const child of node.children) {
          visit(child, [...containerStack, name]);
        }
        return;
      }

      if (node.type === 'method') {
        const nameNode = node.childForFieldName('name') ?? node.children.find((c: AnyNode) => c.type === 'identifier');
        const methodName = nameNode?.text ?? 'unknown';
        const qualifiedName = containerStack.length > 0
          ? `${containerStack[containerStack.length - 1]}#${methodName}`
          : methodName;

        const lineStart = node.startPosition.row + 1;
        const lineEnd = node.endPosition.row + 1;
        const content = lines.slice(lineStart - 1, lineEnd).join('\n');
        const firstLine = lines[lineStart - 1] ?? '';

        symbols.push({
          symbolName: qualifiedName,
          symbolType: 'method',
          lineStart,
          lineEnd,
          content,
          embedText: this.buildEmbedText('Ruby', 'method', filePath, qualifiedName, firstLine),
        });
        return;
      }

      for (const child of node.children) {
        visit(child, containerStack);
      }
    };

    visit(tree.rootNode, []);
    return symbols;
  }

  private extractTypeScriptSymbols(
    tree: AnyNode,
    code: string,
    filePath: string,
    language: string,
  ): ExtractedSymbol[] {
    const symbols: ExtractedSymbol[] = [];
    const lines = code.split('\n');
    const langLabel = language === 'tsx' ? 'TSX' : 'TypeScript';

    const addSymbol = (
      node: AnyNode,
      name: string,
      symbolType: string,
    ) => {
      const lineStart = node.startPosition.row + 1;
      const lineEnd = node.endPosition.row + 1;
      const content = lines.slice(lineStart - 1, lineEnd).join('\n');
      const firstLine = lines[lineStart - 1] ?? '';
      symbols.push({
        symbolName: name,
        symbolType,
        lineStart,
        lineEnd,
        content,
        embedText: this.buildEmbedText(langLabel, symbolType, filePath, name, firstLine),
      });
    };

    const visit = (node: AnyNode, containerName: string | null) => {
      if (node.type === 'export_statement') {
        const decl = node.childForFieldName('declaration') ?? node.children.find((c: AnyNode) =>
          ['function_declaration', 'class_declaration', 'interface_declaration', 'lexical_declaration'].includes(c.type)
        );

        if (!decl) {
          for (const child of node.children) visit(child, containerName);
          return;
        }

        if (decl.type === 'function_declaration') {
          const nameNode = decl.childForFieldName('name') ?? decl.children.find((c: AnyNode) => c.type === 'identifier');
          if (nameNode) {
            addSymbol(node, nameNode.text, 'function');
          }
        } else if (decl.type === 'class_declaration') {
          const nameNode = decl.childForFieldName('name') ?? decl.children.find((c: AnyNode) => c.type === 'type_identifier');
          if (nameNode) {
            const className = nameNode.text;
            addSymbol(node, className, 'class');
            // Visit class body for methods
            const body = decl.childForFieldName('body') ?? decl.children.find((c: AnyNode) => c.type === 'class_body');
            if (body) {
              for (const child of body.children) {
                visit(child, className);
              }
            }
          }
        } else if (decl.type === 'interface_declaration') {
          const nameNode = decl.childForFieldName('name') ?? decl.children.find((c: AnyNode) => c.type === 'type_identifier');
          if (nameNode) {
            addSymbol(node, nameNode.text, 'interface');
          }
        } else if (decl.type === 'lexical_declaration') {
          // Check for arrow function assigned to PascalCase variable (React component)
          for (const varDeclarator of decl.children) {
            if (varDeclarator.type !== 'variable_declarator') continue;
            const varName = varDeclarator.childForFieldName('name') ?? varDeclarator.children.find((c: AnyNode) => c.type === 'identifier');
            const value = varDeclarator.childForFieldName('value') ?? varDeclarator.children.find((c: AnyNode) => c.type === 'arrow_function');
            if (varName && value?.type === 'arrow_function') {
              const name = varName.text;
              const isPascalCase = /^[A-Z]/.test(name);
              if (isPascalCase) {
                addSymbol(node, name, 'component');
              } else {
                addSymbol(node, name, 'function');
              }
            }
          }
        }
        return;
      }

      if (node.type === 'method_definition' && containerName) {
        const nameNode = node.childForFieldName('name') ?? node.children.find((c: AnyNode) => c.type === 'property_identifier');
        if (nameNode) {
          const qualifiedName = `${containerName}#${nameNode.text}`;
          addSymbol(node, qualifiedName, 'method');
        }
        return;
      }

      for (const child of node.children) {
        visit(child, containerName);
      }
    };

    visit(tree.rootNode, null);
    return symbols;
  }

  private windowChunk(
    code: string,
    filePath: string,
    language: string,
  ): ExtractedSymbol[] {
    const lines = code.split('\n');
    const WINDOW = 100;
    const OVERLAP = 20;
    const chunks: ExtractedSymbol[] = [];

    for (let start = 0; start < lines.length; start += WINDOW - OVERLAP) {
      const end = Math.min(start + WINDOW, lines.length);
      const content = lines.slice(start, end).join('\n');
      chunks.push({
        symbolName: `${filePath}:${start + 1}-${end}`,
        symbolType: 'chunk',
        lineStart: start + 1,
        lineEnd: end,
        content,
        embedText: `${language} chunk ${filePath}\nlines ${start + 1}-${end}\n${content.slice(0, 200)}`,
      });
      if (end >= lines.length) break;
    }

    return chunks;
  }

  private buildEmbedText(
    language: string,
    symbolType: string,
    filePath: string,
    symbolName: string,
    firstLine: string,
  ): string {
    return `${language} ${symbolType} ${filePath}\n${symbolName}\n${firstLine}`;
  }
}

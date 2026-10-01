import ts from "typescript";
import { posix } from "node:path";
import {
  isProductNode,
  literalText,
  parseApplicationSource,
} from "./source-analysis.js";

/** Resolve literal plan constants through actual relative imports, never by
 * matching an unrelated same-named constant elsewhere in the repository. */
export function planConstantResolver(sources: Map<string, string>) {
  const modules = new Map<
    string,
    {
      values: Map<string, ts.Expression>;
      imports: Map<string, { source: string; name: string }>;
      exports: Set<string>;
    }
  >();
  for (const [path, source] of sources) {
    const module = {
      values: new Map<string, ts.Expression>(),
      imports: new Map<string, { source: string; name: string }>(),
      exports: new Set<string>(),
    };
    modules.set(path, module);
    const file = parseApplicationSource(path, source);
    const add = (
      name: string,
      expression: ts.Expression,
      exported: boolean,
    ) => {
      module.values.set(name, expression);
      if (exported) module.exports.add(name.split(".")[0]!);
    };
    for (const statement of file.statements) {
      if (!isProductNode(statement)) continue;
      const exported =
        ts.canHaveModifiers(statement) &&
        Boolean(
          ts
            .getModifiers(statement)
            ?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword),
        );
      if (
        ts.isImportDeclaration(statement) &&
        ts.isStringLiteral(statement.moduleSpecifier) &&
        !statement.importClause?.isTypeOnly
      ) {
        const clause = statement.importClause;
        const source = statement.moduleSpecifier.text;
        if (clause?.name)
          module.imports.set(clause.name.text, { source, name: "default" });
        const bindings = clause?.namedBindings;
        if (bindings && ts.isNamedImports(bindings))
          for (const element of bindings.elements) {
            if (!element.isTypeOnly)
              module.imports.set(element.name.text, {
                source,
                name: element.propertyName?.text ?? element.name.text,
              });
          }
        else if (bindings && ts.isNamespaceImport(bindings))
          module.imports.set(bindings.name.text, { source, name: "" });
      }
      if (ts.isVariableStatement(statement))
        for (const declaration of statement.declarationList.declarations) {
          if (
            !ts.isIdentifier(declaration.name) ||
            !declaration.initializer ||
            !isProductNode(declaration)
          )
            continue;
          let expression = declaration.initializer;
          while (
            ts.isAsExpression(expression) ||
            ts.isSatisfiesExpression(expression) ||
            ts.isParenthesizedExpression(expression)
          )
            expression = expression.expression;
          const name = declaration.name.text;
          add(name, expression, exported);
          if (ts.isObjectLiteralExpression(expression))
            for (const property of expression.properties) {
              if (
                ts.isPropertyAssignment(property) &&
                !ts.isComputedPropertyName(property.name)
              )
                add(
                  `${name}.${property.name.getText(file).replace(/["']/g, "")}`,
                  property.initializer,
                  exported,
                );
            }
        }
      if (ts.isEnumDeclaration(statement))
        for (const member of statement.members) {
          if (member.initializer && !ts.isComputedPropertyName(member.name))
            add(
              `${statement.name.text}.${member.name.getText(file).replace(/["']/g, "")}`,
              member.initializer,
              exported,
            );
        }
      if (ts.isExportAssignment(statement))
        add("default", statement.expression, true);
    }
  }
  const resolve = (
    path: string,
    reference: string,
    depth = 0,
  ): string | null => {
    if (depth > 12) return null;
    const module = modules.get(path);
    if (!module) return null;
    const value = module.values.get(reference);
    if (value) {
      const literal = literalText(value);
      if (literal !== null) return literal.toLowerCase();
      if (ts.isIdentifier(value) || ts.isPropertyAccessExpression(value))
        return resolve(path, value.getText(), depth + 1);
      return null;
    }
    const [first, ...tail] = reference.split(".");
    const imported = module.imports.get(first!);
    if (!imported?.source.startsWith(".")) return null;
    const base = posix.normalize(
      posix.join(posix.dirname(path), imported.source),
    );
    if (base.startsWith("../")) return null;
    const stem = base.replace(/\.[cm]?jsx?$/, "");
    const target = [
      base,
      ...[
        ".ts",
        ".tsx",
        ".js",
        ".jsx",
        ".mjs",
        ".cjs",
        "/index.ts",
        "/index.js",
      ].map((ext) => stem + ext),
    ].find((candidate) => modules.has(candidate));
    if (!target) return null;
    const member = [imported.name, ...tail].filter(Boolean).join(".");
    if (!modules.get(target)!.exports.has(member.split(".")[0]!)) return null;
    return resolve(target, member, depth + 1);
  };
  return (path: string, reference: string, line?: number): string | null => {
    if (line !== undefined) {
      const file = parseApplicationSource(path, sources.get(path) ?? "");
      const root = reference.split(".")[0]!;
      let shadowed = false;
      const binds = (name: ts.BindingName): boolean =>
        ts.isIdentifier(name)
          ? name.text === root
          : name.elements.some(
              (element) => ts.isBindingElement(element) && binds(element.name),
            );
      const containsLine = (node: ts.Node) =>
        file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1 <=
          line && file.getLineAndCharacterOfPosition(node.end).line + 1 >= line;
      const visit = (node: ts.Node) => {
        if (!containsLine(node)) return;
        if (
          ts.isFunctionLike(node) &&
          node.parameters.some((p) => binds(p.name))
        )
          shadowed = true;
        if (
          ts.isCatchClause(node) &&
          node.variableDeclaration &&
          binds(node.variableDeclaration.name)
        )
          shadowed = true;
        if (ts.isBlock(node)) {
          for (const statement of node.statements) {
            if (
              ts.isVariableStatement(statement) &&
              statement.declarationList.declarations.some((d) => binds(d.name))
            )
              shadowed = true;
            if (
              (ts.isFunctionDeclaration(statement) ||
                ts.isClassDeclaration(statement)) &&
              statement.name?.text === root
            )
              shadowed = true;
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(file);
      if (shadowed) return null;
    }
    return resolve(path, reference);
  };
}

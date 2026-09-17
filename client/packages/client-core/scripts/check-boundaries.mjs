import { readFileSync, readdirSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'

export const sourceRoot = fileURLToPath(new URL('../src/', import.meta.url))

// The compiler rejects platform globals. This check closes the module/ambient
// type escape hatches that would otherwise bring platform APIs into core.
export function checkSource(text, fileName, root = sourceRoot) {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true)
  const errors = []
  const report = (message) => errors.push(`${fileName}: ${message}`)

  if (source.referencedFiles.length || source.typeReferenceDirectives.length || source.libReferenceDirectives.length) {
    report('Triple-slash references are not allowed in client core.')
  }

  function checkImport(specifier) {
    if (!specifier || !ts.isStringLiteralLike(specifier)) {
      report('Imports must use a static module path.')
      return
    }
    const name = specifier.text
    if (name === 'zustand/vanilla') return
    if (name.startsWith('./') || name.startsWith('../')) {
      const target = relative(root, resolve(dirname(fileName), name))
      if (target && target !== '..' && !target.startsWith('../') && !target.startsWith('..\\') && !isAbsolute(target)) return
    }
    report(`Import "${name}" is outside client core; only core files and zustand/vanilla are allowed.`)
  }

  function visit(node) {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier) checkImport(node.moduleSpecifier)
    } else if (ts.isImportTypeNode(node)) {
      checkImport(ts.isLiteralTypeNode(node.argument) ? node.argument.literal : undefined)
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      checkImport(node.moduleReference.expression)
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      checkImport(node.arguments[0])
    } else if (ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword) {
      report('import.meta belongs in platform adapters.')
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return errors
}

export function checkBoundaries(directory = sourceRoot) {
  const errors = []
  function scan(folder) {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const fileName = resolve(folder, entry.name)
      if (entry.isDirectory()) scan(fileName)
      else if (/\.(?:[cm]?[jt]s|[jt]sx)$/.test(entry.name)) {
        errors.push(...checkSource(readFileSync(fileName, 'utf8'), fileName, directory))
      }
    }
  }
  scan(directory)
  return errors
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const errors = checkBoundaries()
  if (errors.length) {
    console.error(errors.join('\n'))
    process.exitCode = 1
  } else {
    console.log('Client core import boundary check passed.')
  }
}

import ts from "typescript";

// 检查自带文案，不检查开发注释、识别用正则或运行时用户数据。
// 数字/#/* 也是 Unicode Emoji 属性成员，不能直接用该属性禁止普通 ASCII。
const NON_ENGLISH_OR_ICON = /[\p{Script=Han}\p{Extended_Pictographic}\p{Emoji_Presentation}\p{Emoji_Modifier}\p{Regional_Indicator}\uFE0F\u20E3✓✗✕✔✖★☆▶●○⊘]/u;
export function hasProductCopyViolation(text: string): boolean { return NON_ENGLISH_OR_ICON.test(text); }
export function productCopyViolations(file: string, text: string): Array<{ file: string; line: number; text: string }> {
	const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
	const violations: Array<{ file: string; line: number; text: string }> = [];
	function visit(node: ts.Node): void {
		if ((ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) && hasProductCopyViolation(node.text)) {
			violations.push({ file, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1, text: node.text });
		}
		ts.forEachChild(node, visit);
	}
	visit(source);
	return violations;
}

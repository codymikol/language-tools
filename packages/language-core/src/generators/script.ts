import { Mapping } from '@volar/language-core';
import * as path from 'path-browserify';
import type * as ts from 'typescript/lib/tsserverlibrary';
import type { ScriptRanges } from '../parsers/scriptRanges';
import type { ScriptSetupRanges } from '../parsers/scriptSetupRanges';
import type { Code, CodeAndStack, SfcBlock, VueCompilerOptions } from '../types';
import { Sfc } from '../types';
import { getSlotsPropertyName, hyphenateTag } from '../utils/shared';
import { eachInterpolationSegment } from '../utils/transform';
import { disableAllFeatures, enableAllFeatures, withStack } from './utils';

interface HelperType {
	name: string;
	usage?: boolean;
	generated?: boolean;
	code: string;
}

export function* generate(
	ts: typeof import('typescript/lib/tsserverlibrary'),
	fileName: string,
	script: Sfc['script'],
	scriptSetup: Sfc['scriptSetup'],
	styles: Sfc['styles'], // TODO: computed it
	lang: string,
	scriptRanges: ScriptRanges | undefined,
	scriptSetupRanges: ScriptSetupRanges | undefined,
	templateCodegen: {
		tsCodes: Code[];
		tsCodegenStacks: string[];
		tagNames: Set<string>;
		accessedGlobalVariables: Set<string>;
		hasSlot: boolean;
	} | undefined,
	compilerOptions: ts.CompilerOptions,
	vueCompilerOptions: VueCompilerOptions,
	globalTypesHolder: string | undefined,
	getGeneratedLength: () => number,
	linkedCodeMappings: Mapping[] = [],
	codegenStack: boolean,
): Generator<CodeAndStack> {

	//#region monkey fix: https://github.com/vuejs/language-tools/pull/2113
	if (!script && !scriptSetup) {
		scriptSetup = {
			content: '',
			lang: 'ts',
			name: '',
			start: 0,
			end: 0,
			startTagEnd: 0,
			endTagStart: 0,
			generic: undefined,
			genericOffset: 0,
			attrs: {},
			ast: ts.createSourceFile('', '', 99 satisfies ts.ScriptTarget.Latest, false, ts.ScriptKind.TS),
		};
		scriptSetupRanges = {
			bindings: [],
			props: {},
			emits: {},
			expose: {},
			slots: {},
			defineProp: [],
			importSectionEndOffset: 0,
			leadingCommentEndOffset: 0,
		};
	}
	//#endregion

	const bindingNames = new Set([
		...scriptRanges?.bindings.map(range => script!.content.substring(range.start, range.end)) ?? [],
		...scriptSetupRanges?.bindings.map(range => scriptSetup!.content.substring(range.start, range.end)) ?? [],
	]);
	const bypassDefineComponent = lang === 'js' || lang === 'jsx';
	const _ = codegenStack ? withStack : (code: Code): CodeAndStack => [code, ''];
	const helperTypes = {
		OmitKeepDiscriminatedUnion: {
			get name() {
				this.usage = true;
				return `__VLS_OmitKeepDiscriminatedUnion`;
			},
			get code() {
				return `type __VLS_OmitKeepDiscriminatedUnion<T, K extends keyof any> = T extends any
					? Pick<T, Exclude<keyof T, K>>
					: never;`;
			},
		} satisfies HelperType as HelperType,
		WithDefaults: {
			get name() {
				this.usage = true;
				return `__VLS_WithDefaults`;
			},
			get code(): string {
				return `type __VLS_WithDefaults<P, D> = {
					[K in keyof Pick<P, keyof P>]: K extends keyof D
						? ${helperTypes.Prettify.name}<P[K] & { default: D[K]}>
						: P[K]
				};`;
			},
		} satisfies HelperType as HelperType,
		Prettify: {
			get name() {
				this.usage = true;
				return `__VLS_Prettify`;
			},
			get code() {
				return `type __VLS_Prettify<T> = { [K in keyof T]: T[K]; } & {};`;
			},
		} satisfies HelperType as HelperType,
		WithTemplateSlots: {
			get name() {
				this.usage = true;
				return `__VLS_WithTemplateSlots`;
			},
			get code(): string {
				return `type __VLS_WithTemplateSlots<T, S> = T & {
					new(): {
						${getSlotsPropertyName(vueCompilerOptions.target)}: S;
						${vueCompilerOptions.jsxSlots ? `$props: ${helperTypes.PropsChildren.name}<S>;` : ''}
					}
				};`;
			},
		} satisfies HelperType as HelperType,
		PropsChildren: {
			get name() {
				this.usage = true;
				return `__VLS_PropsChildren`;
			},
			get code() {
				return `type __VLS_PropsChildren<S> = {
					[K in keyof (
						boolean extends (
							// @ts-ignore
							JSX.ElementChildrenAttribute extends never
								? true
								: false
						)
							? never
							// @ts-ignore
							: JSX.ElementChildrenAttribute
					)]?: S;
				};`;
			},
		} satisfies HelperType as HelperType,
		TypePropsToOption: {
			get name() {
				this.usage = true;
				return `__VLS_TypePropsToOption`;
			},
			get code() {
				return compilerOptions.exactOptionalPropertyTypes ?
					`type __VLS_TypePropsToOption<T> = {
						[K in keyof T]-?: {} extends Pick<T, K>
							? { type: import('${vueCompilerOptions.lib}').PropType<T[K]> }
							: { type: import('${vueCompilerOptions.lib}').PropType<T[K]>, required: true }
					};` :
					`type __VLS_NonUndefinedable<T> = T extends undefined ? never : T;
					type __VLS_TypePropsToOption<T> = {
						[K in keyof T]-?: {} extends Pick<T, K>
							? { type: import('${vueCompilerOptions.lib}').PropType<__VLS_NonUndefinedable<T[K]>> }
							: { type: import('${vueCompilerOptions.lib}').PropType<T[K]>, required: true }
					};`;
			},
		} satisfies HelperType as HelperType,
	};

	let generatedTemplate = false;
	let scriptSetupGeneratedOffset: number | undefined;

	yield _(`/* __placeholder__ */\n`);
	yield* generateSrc();
	yield* generateScriptSetupImports();
	yield* generateScriptContentBeforeExportDefault();
	yield* generateScriptSetupAndTemplate();
	yield* generateScriptContentAfterExportDefault();
	if (globalTypesHolder === fileName) {
		yield* generateGlobalHelperTypes();
	}
	yield* generateLocalHelperTypes();
	yield _(`\ntype __VLS_IntrinsicElementsCompletion = __VLS_IntrinsicElements;\n`);

	if (!generatedTemplate) {
		yield* generateTemplate(false);
	}

	if (scriptSetup) {
		yield _(['', 'scriptSetup', scriptSetup.content.length, disableAllFeatures({ verification: true })]);
	}

	function* generateGlobalHelperTypes(): Generator<CodeAndStack> {
		const fnPropsType = `(K extends { $props: infer Props } ? Props : any)${vueCompilerOptions.strictTemplates ? '' : ' & Record<string, unknown>'}`;
		yield _(`
; declare global {
// @ts-ignore
type __VLS_IntrinsicElements = __VLS_PickNotAny<import('vue/jsx-runtime').JSX.IntrinsicElements, __VLS_PickNotAny<JSX.IntrinsicElements, Record<string, any>>>;
// @ts-ignore
type __VLS_Element = __VLS_PickNotAny<import('vue/jsx-runtime').JSX.Element, JSX.Element>;
// @ts-ignore
type __VLS_GlobalComponents = ${[
				`__VLS_PickNotAny<import('vue').__VLS_GlobalComponents, {}>`,
				`__VLS_PickNotAny<import('@vue/runtime-core').__VLS_GlobalComponents, {}>`,
				`__VLS_PickNotAny<import('@vue/runtime-dom').__VLS_GlobalComponents, {}>`,
				`Pick<typeof import('${vueCompilerOptions.lib}'), 'Transition' | 'TransitionGroup' | 'KeepAlive' | 'Suspense' | 'Teleport'>`
			].join(' & ')};
type __VLS_IsAny<T> = 0 extends 1 & T ? true : false;
type __VLS_PickNotAny<A, B> = __VLS_IsAny<A> extends true ? B : A;

const __VLS_intrinsicElements: __VLS_IntrinsicElements;

// v-for
function __VLS_getVForSourceType(source: number): [number, number, number][];
function __VLS_getVForSourceType(source: string): [string, number, number][];
function __VLS_getVForSourceType<T extends any[]>(source: T): [
	T[number], // item
	number, // key
	number, // index
][];
function __VLS_getVForSourceType<T extends { [Symbol.iterator](): Iterator<any> }>(source: T): [
	T extends { [Symbol.iterator](): Iterator<infer T1> } ? T1 : never, // item 
	number, // key
	undefined, // index
][];
function __VLS_getVForSourceType<T>(source: T): [
	T[keyof T], // item
	keyof T, // key
	number, // index
][];

// @ts-ignore
function __VLS_getSlotParams<T>(slot: T): Parameters<__VLS_PickNotAny<NonNullable<T>, (...args: any[]) => any>>;
// @ts-ignore
function __VLS_getSlotParam<T>(slot: T): Parameters<__VLS_PickNotAny<NonNullable<T>, (...args: any[]) => any>>[0];
function __VLS_directiveFunction<T>(dir: T):
	T extends import('${vueCompilerOptions.lib}').ObjectDirective<infer E, infer V> | import('${vueCompilerOptions.lib}').FunctionDirective<infer E, infer V> ? (value: V) => void
	: T;
function __VLS_withScope<T, K>(ctx: T, scope: K): ctx is T & K;
function __VLS_makeOptional<T>(t: T): { [K in keyof T]?: T[K] };

type __VLS_SelfComponent<N, C> = string extends N ? {} : N extends string ? { [P in N]: C } : {};
type __VLS_WithComponent<N0 extends string, LocalComponents, N1 extends string, N2 extends string, N3 extends string> =
	N1 extends keyof LocalComponents ? N1 extends N0 ? Pick<LocalComponents, N0 extends keyof LocalComponents ? N0 : never> : { [K in N0]: LocalComponents[N1] } :
	N2 extends keyof LocalComponents ? N2 extends N0 ? Pick<LocalComponents, N0 extends keyof LocalComponents ? N0 : never> : { [K in N0]: LocalComponents[N2] } :
	N3 extends keyof LocalComponents ? N3 extends N0 ? Pick<LocalComponents, N0 extends keyof LocalComponents ? N0 : never> : { [K in N0]: LocalComponents[N3] } :
	N1 extends keyof __VLS_GlobalComponents ? N1 extends N0 ? Pick<__VLS_GlobalComponents, N0 extends keyof __VLS_GlobalComponents ? N0 : never> : { [K in N0]: __VLS_GlobalComponents[N1] } :
	N2 extends keyof __VLS_GlobalComponents ? N2 extends N0 ? Pick<__VLS_GlobalComponents, N0 extends keyof __VLS_GlobalComponents ? N0 : never> : { [K in N0]: __VLS_GlobalComponents[N2] } :
	N3 extends keyof __VLS_GlobalComponents ? N3 extends N0 ? Pick<__VLS_GlobalComponents, N0 extends keyof __VLS_GlobalComponents ? N0 : never> : { [K in N0]: __VLS_GlobalComponents[N3] } :
	${vueCompilerOptions.strictTemplates ? '{}' : '{ [K in N0]: unknown }'}

type __VLS_FillingEventArg_ParametersLength<E extends (...args: any) => any> = __VLS_IsAny<Parameters<E>> extends true ? -1 : Parameters<E>['length'];
type __VLS_FillingEventArg<E> = E extends (...args: any) => any ? __VLS_FillingEventArg_ParametersLength<E> extends 0 ? ($event?: undefined) => ReturnType<E> : E : E;
function __VLS_asFunctionalComponent<T, K = T extends new (...args: any) => any ? InstanceType<T> : unknown>(t: T, instance?: K):
	T extends new (...args: any) => any
	? (props: ${fnPropsType}, ctx?: any) => JSX.Element & { __ctx?: {
		attrs?: any,
		slots?: K extends { ${getSlotsPropertyName(vueCompilerOptions.target)}: infer Slots } ? Slots : any,
		emit?: K extends { $emit: infer Emit } ? Emit : any
	} & { props?: ${fnPropsType}; expose?(exposed: K): void; } }
	: T extends () => any ? (props: {}, ctx?: any) => ReturnType<T>
	: T extends (...args: any) => any ? T
	: (_: {}${vueCompilerOptions.strictTemplates ? '' : ' & Record<string, unknown>'}, ctx?: any) => { __ctx?: { attrs?: any, expose?: any, slots?: any, emit?: any, props?: {}${vueCompilerOptions.strictTemplates ? '' : ' & Record<string, unknown>'} } };
function __VLS_elementAsFunctionalComponent<T>(t: T): (_: T${vueCompilerOptions.strictTemplates ? '' : ' & Record<string, unknown>'}, ctx?: any) => { __ctx?: { attrs?: any, expose?: any, slots?: any, emit?: any, props?: T${vueCompilerOptions.strictTemplates ? '' : ' & Record<string, unknown>'} } };
function __VLS_functionalComponentArgsRest<T extends (...args: any) => any>(t: T): Parameters<T>['length'] extends 2 ? [any] : [];
function __VLS_pickEvent<E1, E2>(emitEvent: E1, propEvent: E2): __VLS_FillingEventArg<
	__VLS_PickNotAny<
		__VLS_AsFunctionOrAny<E2>,
		__VLS_AsFunctionOrAny<E1>
	>
> | undefined;
function __VLS_pickFunctionalComponentCtx<T, K>(comp: T, compInstance: K): __VLS_PickNotAny<
	'__ctx' extends keyof __VLS_PickNotAny<K, {}> ? K extends { __ctx?: infer Ctx } ? Ctx : never : any
	, T extends (props: any, ctx: infer Ctx) => any ? Ctx : any
>;
type __VLS_FunctionalComponentProps<T, K> =
	'__ctx' extends keyof __VLS_PickNotAny<K, {}> ? K extends { __ctx?: { props?: infer P } } ? NonNullable<P> : never
	: T extends (props: infer P, ...args: any) => any ? P :
	{};
type __VLS_AsFunctionOrAny<F> = unknown extends F ? any : ((...args: any) => any) extends F ? F : any;

function __VLS_normalizeSlot<S>(s: S): S extends () => infer R ? (props: {}) => R : S;

/**
 * emit
 */
// fix https://github.com/vuejs/language-tools/issues/926
type __VLS_UnionToIntersection<U> = (U extends unknown ? (arg: U) => unknown : never) extends ((arg: infer P) => unknown) ? P : never;
type __VLS_OverloadUnionInner<T, U = unknown> = U & T extends (...args: infer A) => infer R
	? U extends T
	? never
	: __VLS_OverloadUnionInner<T, Pick<T, keyof T> & U & ((...args: A) => R)> | ((...args: A) => R)
	: never;
type __VLS_OverloadUnion<T> = Exclude<
	__VLS_OverloadUnionInner<(() => never) & T>,
	T extends () => never ? never : () => never
>;
type __VLS_ConstructorOverloads<T> = __VLS_OverloadUnion<T> extends infer F
	? F extends (event: infer E, ...args: infer A) => any
	? { [K in E & string]: (...args: A) => void; }
	: never
	: never;
type __VLS_NormalizeEmits<T> = __VLS_PrettifyGlobal<
	__VLS_UnionToIntersection<
		__VLS_ConstructorOverloads<T> & {
			[K in keyof T]: T[K] extends any[] ? { (...args: T[K]): void } : never
		}
	>
>;
type __VLS_PrettifyGlobal<T> = { [K in keyof T]: T[K]; } & {};
}
`);
	}
	function* generateLocalHelperTypes(): Generator<CodeAndStack> {
		let shouldCheck = true;
		while (shouldCheck) {
			shouldCheck = false;
			for (const helperType of Object.values(helperTypes)) {
				if (helperType.usage && !helperType.generated) {
					shouldCheck = true;
					helperType.generated = true;
					yield _('\n' + helperType.code + '\n');
				}
			}
		}
	}
	function* generateSrc(): Generator<CodeAndStack> {
		if (!script?.src)
			return;

		let src = script.src;

		if (src.endsWith('.d.ts'))
			src = src.substring(0, src.length - '.d.ts'.length);
		else if (src.endsWith('.ts'))
			src = src.substring(0, src.length - '.ts'.length);
		else if (src.endsWith('.tsx'))
			src = src.substring(0, src.length - '.tsx'.length) + '.jsx';

		if (!src.endsWith('.js') && !src.endsWith('.jsx'))
			src = src + '.js';

		yield _(`export * from `);
		yield _([
			`'${src}'`,
			'script',
			script.srcOffset - 1,
			enableAllFeatures({
				navigation: src === script.src ? true : {
					shouldRename: () => false,
					resolveRenameEditText(newName) {
						if (newName.endsWith('.jsx') || newName.endsWith('.js')) {
							newName = newName.split('.').slice(0, -1).join('.');
						}
						if (script?.src?.endsWith('.d.ts')) {
							newName = newName + '.d.ts';
						}
						else if (script?.src?.endsWith('.ts')) {
							newName = newName + '.ts';
						}
						else if (script?.src?.endsWith('.tsx')) {
							newName = newName + '.tsx';
						}
						return newName;
					},
				},
			}),
		]);
		yield _(`;\n`);
		yield _(`export { default } from '${src}';\n`);
	}
	function* generateScriptContentBeforeExportDefault(): Generator<CodeAndStack> {
		if (!script)
			return;

		if (!!scriptSetup && scriptRanges?.exportDefault)
			return yield _(generateSourceCode(script, 0, scriptRanges.exportDefault.expression.start));

		let isExportRawObject = false;
		if (scriptRanges?.exportDefault)
			isExportRawObject = script.content.substring(scriptRanges.exportDefault.expression.start, scriptRanges.exportDefault.expression.end).startsWith('{');

		if (!isExportRawObject || !vueCompilerOptions.optionsWrapper.length || !scriptRanges?.exportDefault)
			return yield _(generateSourceCode(script, 0, script.content.length));

		yield _(generateSourceCode(script, 0, scriptRanges.exportDefault.expression.start));
		yield _(vueCompilerOptions.optionsWrapper[0]);
		yield _(['', 'script', scriptRanges.exportDefault.expression.start, disableAllFeatures({
			__hint: {
				setting: 'vue.inlayHints.optionsWrapper',
				label: vueCompilerOptions.optionsWrapper[0],
				tooltip: [
					'This is virtual code that is automatically wrapped for type support, it does not affect your runtime behavior, you can customize it via `vueCompilerOptions.optionsWrapper` option in tsconfig / jsconfig.',
					'To hide it, you can set `"vue.inlayHints.optionsWrapper": false` in IDE settings.',
				].join('\n\n'),
			}
		})]);
		yield _(generateSourceCode(script, scriptRanges.exportDefault.expression.start, scriptRanges.exportDefault.expression.end));
		yield _(['', 'script', scriptRanges.exportDefault.expression.end, disableAllFeatures({
			__hint: {
				setting: 'vue.inlayHints.optionsWrapper',
				label: vueCompilerOptions.optionsWrapper[1],
				tooltip: '',
			}
		})]);
		yield _(vueCompilerOptions.optionsWrapper[1]);
		yield _(generateSourceCode(script, scriptRanges.exportDefault.expression.end, script.content.length));
	}
	function* generateScriptContentAfterExportDefault(): Generator<CodeAndStack> {
		if (!script)
			return;

		if (!!scriptSetup && scriptRanges?.exportDefault)
			yield _(generateSourceCode(script, scriptRanges.exportDefault.expression.end, script.content.length));
	}
	function* generateScriptSetupImports(): Generator<CodeAndStack> {
		if (!scriptSetup || !scriptSetupRanges)
			return;

		yield _([
			scriptSetup.content.substring(0, Math.max(scriptSetupRanges.importSectionEndOffset, scriptSetupRanges.leadingCommentEndOffset)) + '\n',
			'scriptSetup',
			0,
			enableAllFeatures({}),
		]);
	}
	function* generateScriptSetupAndTemplate(): Generator<CodeAndStack> {
		if (!scriptSetup || !scriptSetupRanges)
			return;

		const definePropMirrors = new Map<string, number>();

		if (scriptSetup.generic) {
			if (!scriptRanges?.exportDefault) {
				yield _(`export default `);
			}
			yield _(`(<`);
			yield _([
				scriptSetup.generic,
				scriptSetup.name,
				scriptSetup.genericOffset,
				enableAllFeatures({}),
			]);
			if (!scriptSetup.generic.endsWith(`,`)) {
				yield _(`,`);
			}
			yield _(`>`);
			yield _(`(\n`
				+ `	__VLS_props: Awaited<typeof __VLS_setup>['props'],\n`
				+ `	__VLS_ctx?: ${helperTypes.Prettify.name}<Pick<Awaited<typeof __VLS_setup>, 'attrs' | 'emit' | 'slots'>>,\n` // use __VLS_Prettify for less dts code
				+ `	__VLS_expose?: NonNullable<Awaited<typeof __VLS_setup>>['expose'],\n`
				+ `	__VLS_setup = (async () => {\n`);

			yield* generateSetupFunction(true, 'none', definePropMirrors);

			//#region props
			yield _(`const __VLS_fnComponent = `
				+ `(await import('${vueCompilerOptions.lib}')).defineComponent({\n`);
			if (scriptSetupRanges.props.define?.arg) {
				yield _(`	props: `);
				yield _(generateSourceCodeForExtraReference(scriptSetup, scriptSetupRanges.props.define.arg.start, scriptSetupRanges.props.define.arg.end));
				yield _(`,\n`);
			}
			if (scriptSetupRanges.emits.define) {
				yield _(`	emits: ({} as __VLS_NormalizeEmits<typeof `);
				yield _(scriptSetupRanges.emits.name ?? '__VLS_emit');
				yield _(`>),\n`);
			}
			yield _(`});\n`);

			if (scriptSetupRanges.defineProp.length) {
				yield _(`const __VLS_defaults = {\n`);
				for (const defineProp of scriptSetupRanges.defineProp) {
					if (defineProp.defaultValue) {
						if (defineProp.name) {
							yield _(scriptSetup.content.substring(defineProp.name.start, defineProp.name.end));
						}
						else {
							yield _('modelValue');
						}
						yield _(`: `);
						yield _(scriptSetup.content.substring(defineProp.defaultValue.start, defineProp.defaultValue.end));
						yield _(`,\n`);
					}
				}
				yield _(`};\n`);
			}

			yield _(`let __VLS_fnPropsTypeOnly!: {}`); // TODO: reuse __VLS_fnPropsTypeOnly even without generic, and remove __VLS_propsOption_defineProp
			if (scriptSetupRanges.props.define?.typeArg) {
				yield _(` & `);
				yield _(generateSourceCode(scriptSetup, scriptSetupRanges.props.define.typeArg.start, scriptSetupRanges.props.define.typeArg.end));
			}
			if (scriptSetupRanges.defineProp.length) {
				yield _(` & {\n`);
				for (const defineProp of scriptSetupRanges.defineProp) {
					let propName = 'modelValue';
					if (defineProp.name) {
						propName = scriptSetup.content.substring(defineProp.name.start, defineProp.name.end);
						definePropMirrors.set(propName, getGeneratedLength());
					}
					yield _(`${propName}${defineProp.required ? '' : '?'}: `);
					if (defineProp.type) {
						yield _(scriptSetup.content.substring(defineProp.type.start, defineProp.type.end));
					}
					else if (defineProp.defaultValue) {
						yield _(`typeof __VLS_defaults['`);
						yield _(propName);
						yield _(`']`);
					}
					else {
						yield _(`any`);
					}
					yield _(',\n');
				}
				yield _(`}`);
			}
			yield _(`;\n`);

			yield _(`let __VLS_fnPropsDefineComponent!: InstanceType<typeof __VLS_fnComponent>['$props'];\n`);
			yield _(`let __VLS_fnPropsSlots!: `);
			if (scriptSetupRanges.slots.define && vueCompilerOptions.jsxSlots) {
				yield _(`${helperTypes.PropsChildren.name}<typeof __VLS_slots>`);
			}
			else {
				yield _(`{}`);
			}
			yield _(`;\n`);

			yield _(`let __VLS_defaultProps!:\n`
				+ `	import('${vueCompilerOptions.lib}').VNodeProps\n`
				+ `	& import('${vueCompilerOptions.lib}').AllowedComponentProps\n`
				+ `	& import('${vueCompilerOptions.lib}').ComponentCustomProps;\n`);
			//#endregion

			yield _(`		return {} as {\n`
				+ `			props: ${helperTypes.Prettify.name}<${helperTypes.OmitKeepDiscriminatedUnion.name}<typeof __VLS_fnPropsDefineComponent & typeof __VLS_fnPropsTypeOnly, keyof typeof __VLS_defaultProps>> & typeof __VLS_fnPropsSlots & typeof __VLS_defaultProps,\n`
				+ `			expose(exposed: import('${vueCompilerOptions.lib}').ShallowUnwrapRef<${scriptSetupRanges.expose.define ? 'typeof __VLS_exposed' : '{}'}>): void,\n`
				+ `			attrs: any,\n`
				+ `			slots: ReturnType<typeof __VLS_template>,\n`
				+ `			emit: typeof ${scriptSetupRanges.emits.name ?? '__VLS_emit'},\n`
				+ `		};\n`);
			yield _(`	})(),\n`); // __VLS_setup = (async () => {
			yield _(`) => ({} as import('${vueCompilerOptions.lib}').VNode & { __ctx?: Awaited<typeof __VLS_setup> }))`);
		}
		else if (!script) {
			// no script block, generate script setup code at root
			yield* generateSetupFunction(false, 'export', definePropMirrors);
		}
		else {
			if (!scriptRanges?.exportDefault) {
				yield _(`export default `);
			}
			yield _(`await (async () => {\n`);
			yield* generateSetupFunction(false, 'return', definePropMirrors);
			yield _(`})()`);
		}

		if (scriptSetupGeneratedOffset !== undefined) {
			for (const defineProp of scriptSetupRanges.defineProp) {
				if (!defineProp.name) {
					continue;
				}
				const propName = scriptSetup.content.substring(defineProp.name.start, defineProp.name.end);
				const propMirror = definePropMirrors.get(propName);
				if (propMirror !== undefined) {
					linkedCodeMappings.push({
						sourceOffsets: [defineProp.name.start + scriptSetupGeneratedOffset],
						generatedOffsets: [propMirror],
						lengths: [defineProp.name.end - defineProp.name.start],
						data: undefined,
					});
				}
			}
		}
	}
	function* generateSetupFunction(functional: boolean, mode: 'return' | 'export' | 'none', definePropMirrors: Map<string, number>): Generator<CodeAndStack> {
		if (!scriptSetupRanges || !scriptSetup)
			return;

		const definePropProposalA = scriptSetup.content.trimStart().startsWith('// @experimentalDefinePropProposal=kevinEdition') || vueCompilerOptions.experimentalDefinePropProposal === 'kevinEdition';
		const definePropProposalB = scriptSetup.content.trimStart().startsWith('// @experimentalDefinePropProposal=johnsonEdition') || vueCompilerOptions.experimentalDefinePropProposal === 'johnsonEdition';

		if (vueCompilerOptions.target >= 3.3) {
			yield _(`const { `);
			for (const macro of Object.keys(vueCompilerOptions.macros)) {
				if (!bindingNames.has(macro)) {
					yield _(macro + `, `);
				}
			}
			yield _(`} = await import('${vueCompilerOptions.lib}');\n`);
		}
		if (definePropProposalA) {
			yield _(`declare function defineProp<T>(name: string, options: { required: true } & Record<string, unknown>): import('${vueCompilerOptions.lib}').ComputedRef<T>;\n`);
			yield _(`declare function defineProp<T>(name: string, options: { default: any } & Record<string, unknown>): import('${vueCompilerOptions.lib}').ComputedRef<T>;\n`);
			yield _(`declare function defineProp<T>(name?: string, options?: any): import('${vueCompilerOptions.lib}').ComputedRef<T | undefined>;\n`);
		}
		if (definePropProposalB) {
			yield _(`declare function defineProp<T>(value: T | (() => T), required?: boolean, rest?: any): import('${vueCompilerOptions.lib}').ComputedRef<T>;\n`);
			yield _(`declare function defineProp<T>(value: T | (() => T) | undefined, required: true, rest?: any): import('${vueCompilerOptions.lib}').ComputedRef<T>;\n`);
			yield _(`declare function defineProp<T>(value?: T | (() => T), required?: boolean, rest?: any): import('${vueCompilerOptions.lib}').ComputedRef<T | undefined>;\n`);
		}

		scriptSetupGeneratedOffset = getGeneratedLength() - scriptSetupRanges.importSectionEndOffset;

		let setupCodeModifies: [Code[], number, number][] = [];
		if (scriptSetupRanges.props.define && !scriptSetupRanges.props.name) {
			const range = scriptSetupRanges.props.withDefaults ?? scriptSetupRanges.props.define;
			const statement = scriptSetupRanges.props.define.statement;
			if (statement.start === range.start && statement.end === range.end) {
				setupCodeModifies.push([[`const __VLS_props = `], range.start, range.start]);
			}
			else {
				setupCodeModifies.push([[
					`const __VLS_props = `,
					generateSourceCode(scriptSetup, range.start, range.end),
					`;\n`,
					generateSourceCode(scriptSetup, statement.start, range.start),
					`__VLS_props`,
				], statement.start, range.end]);
			}
		}
		if (scriptSetupRanges.slots.define && !scriptSetupRanges.slots.name) {
			setupCodeModifies.push([[`const __VLS_slots = `], scriptSetupRanges.slots.define.start, scriptSetupRanges.slots.define.start]);
		}
		if (scriptSetupRanges.emits.define && !scriptSetupRanges.emits.name) {
			setupCodeModifies.push([[`const __VLS_emit = `], scriptSetupRanges.emits.define.start, scriptSetupRanges.emits.define.start]);
		}
		if (scriptSetupRanges.expose.define) {
			if (scriptSetupRanges.expose.define?.typeArg) {
				setupCodeModifies.push([
					[
						`let __VLS_exposed!: `,
						generateSourceCodeForExtraReference(scriptSetup, scriptSetupRanges.expose.define.typeArg.start, scriptSetupRanges.expose.define.typeArg.end),
						`;\n`,
					],
					scriptSetupRanges.expose.define.start,
					scriptSetupRanges.expose.define.start,
				]);
			}
			else if (scriptSetupRanges.expose.define?.arg) {
				setupCodeModifies.push([
					[
						`const __VLS_exposed = `,
						generateSourceCodeForExtraReference(scriptSetup, scriptSetupRanges.expose.define.arg.start, scriptSetupRanges.expose.define.arg.end),
						`;\n`,
					],
					scriptSetupRanges.expose.define.start,
					scriptSetupRanges.expose.define.start,
				]);
			}
			else {
				setupCodeModifies.push([
					[`const __VLS_exposed = {};\n`],
					scriptSetupRanges.expose.define.start,
					scriptSetupRanges.expose.define.start,
				]);
			}
		}
		setupCodeModifies = setupCodeModifies.sort((a, b) => a[1] - b[1]);

		if (setupCodeModifies.length) {
			yield _(generateSourceCode(scriptSetup, scriptSetupRanges.importSectionEndOffset, setupCodeModifies[0][1]));
			while (setupCodeModifies.length) {
				const [codes, _start, end] = setupCodeModifies.shift()!;
				for (const code of codes) {
					yield _(code);
				}
				if (setupCodeModifies.length) {
					const nextStart = setupCodeModifies[0][1];
					yield _(generateSourceCode(scriptSetup, end, nextStart));
				}
				else {
					yield _(generateSourceCode(scriptSetup, end));
				}
			}
		}
		else {
			yield _(generateSourceCode(scriptSetup, scriptSetupRanges.importSectionEndOffset));
		}

		if (scriptSetupRanges.props.define?.typeArg && scriptSetupRanges.props.withDefaults?.arg) {
			// fix https://github.com/vuejs/language-tools/issues/1187
			yield _(`const __VLS_withDefaultsArg = (function <T>(t: T) { return t })(`);
			yield _(generateSourceCodeForExtraReference(scriptSetup, scriptSetupRanges.props.withDefaults.arg.start, scriptSetupRanges.props.withDefaults.arg.end));
			yield _(`);\n`);
		}

		if (!functional && scriptSetupRanges.defineProp.length) {
			yield _(`let __VLS_propsOption_defineProp!: {\n`);
			for (const defineProp of scriptSetupRanges.defineProp) {

				let propName = 'modelValue';

				if (defineProp.name && defineProp.nameIsString) {
					// renaming support
					yield _(generateSourceCodeForExtraReference(scriptSetup, defineProp.name.start, defineProp.name.end));
				}
				else if (defineProp.name) {
					propName = scriptSetup.content.substring(defineProp.name.start, defineProp.name.end);
					const start = getGeneratedLength();
					definePropMirrors.set(propName, start);
					yield _(propName);
				}
				else {
					yield _(propName);
				}
				yield _(`: `);

				let type = 'any';
				if (!defineProp.nameIsString) {
					type = `NonNullable<typeof ${propName}['value']>`;
				}
				else if (defineProp.type) {
					type = scriptSetup.content.substring(defineProp.type.start, defineProp.type.end);
				}

				if (defineProp.required) {
					yield _(`{ required: true, type: import('${vueCompilerOptions.lib}').PropType<${type}> },\n`);
				}
				else {
					yield _(`import('${vueCompilerOptions.lib}').PropType<${type}>,\n`);
				}
			}
			yield _(`};\n`);
		}

		yield* generateTemplate(functional);

		if (mode === 'return' || mode === 'export') {
			if (!vueCompilerOptions.skipTemplateCodegen && (templateCodegen?.hasSlot || scriptSetupRanges?.slots.define)) {
				yield _(`const __VLS_component = `);
				yield* generateComponent(functional);
				yield _(`;\n`);
				yield _(mode === 'return' ? 'return ' : 'export default ');
				yield _(`{} as ${helperTypes.WithTemplateSlots.name}<typeof __VLS_component, ReturnType<typeof __VLS_template>>;\n`);
			}
			else {
				yield _(mode === 'return' ? 'return ' : 'export default ');
				yield* generateComponent(functional);
				yield _(`;\n`);
			}
		}
	}
	function* generateComponent(functional: boolean): Generator<CodeAndStack> {
		if (!scriptSetupRanges)
			return;

		if (script && scriptRanges?.exportDefault && scriptRanges.exportDefault.expression.start !== scriptRanges.exportDefault.args.start) {
			// use defineComponent() from user space code if it exist
			yield _(generateSourceCode(script, scriptRanges.exportDefault.expression.start, scriptRanges.exportDefault.args.start));
			yield _(`{\n`);
		}
		else {
			yield _(`(await import('${vueCompilerOptions.lib}')).defineComponent({\n`);
		}

		yield _(`setup() {\n`);
		yield _(`return {\n`);
		yield* generateSetupReturns();
		if (scriptSetupRanges.expose.define) {
			yield _(`...__VLS_exposed,\n`);
		}
		yield _(`};\n`);
		yield _(`},\n`);
		yield* generateComponentOptions(functional);
		yield _(`})`);
	}
	function* generateComponentOptions(functional: boolean): Generator<CodeAndStack> {
		if (scriptSetup && scriptSetupRanges && !bypassDefineComponent) {

			const ranges = scriptSetupRanges;
			const propsCodegens: (() => Generator<CodeAndStack>)[] = [];

			if (ranges.props.define?.arg) {
				const arg = ranges.props.define.arg;
				propsCodegens.push(function* () {
					yield _(generateSourceCodeForExtraReference(scriptSetup!, arg.start, arg.end));
				});
			}
			if (ranges.props.define?.typeArg) {
				const typeArg = ranges.props.define.typeArg;
				propsCodegens.push(function* () {

					yield _(`{} as `);

					if (ranges.props.withDefaults?.arg) {
						yield _(`${helperTypes.WithDefaults.name}<`);
					}

					yield _(`${helperTypes.TypePropsToOption.name}<`);
					if (functional) {
						yield _(`typeof __VLS_fnPropsTypeOnly`);
					}
					else {
						yield _(generateSourceCodeForExtraReference(scriptSetup!, typeArg.start, typeArg.end));
					}
					yield _(`>`);

					if (ranges.props.withDefaults?.arg) {
						yield _(`, typeof __VLS_withDefaultsArg`);
						yield _(`>`);
					}
				});
			}
			if (!functional && ranges.defineProp.length) {
				propsCodegens.push(function* () {
					yield _(`__VLS_propsOption_defineProp`);
				});
			}

			if (propsCodegens.length === 1) {
				yield _(`props: `);
				for (const generate of propsCodegens) {
					yield* generate();
				}
				yield _(`,\n`);
			}
			else if (propsCodegens.length >= 2) {
				yield _(`props: {\n`);
				for (const generate of propsCodegens) {
					yield _(`...`);
					yield* generate();
					yield _(`,\n`);
				}
				yield _(`},\n`);
			}
			if (ranges.emits.define) {
				yield _(`emits: ({} as __VLS_NormalizeEmits<typeof `);
				yield _(ranges.emits.name ?? '__VLS_emit');
				yield _(`>),\n`);
			}
		}
		if (script && scriptRanges?.exportDefault?.args) {
			yield _(generateSourceCode(script, scriptRanges.exportDefault.args.start + 1, scriptRanges.exportDefault.args.end - 1));
		}
	}
	function* generateSetupReturns(): Generator<CodeAndStack> {
		if (scriptSetupRanges && bypassDefineComponent) {
			// fill $props
			if (scriptSetupRanges.props.define) {
				// NOTE: defineProps is inaccurate for $props
				yield _(`$props: __VLS_makeOptional(${scriptSetupRanges.props.name ?? `__VLS_props`}),\n`);
				yield _(`...${scriptSetupRanges.props.name ?? `__VLS_props`},\n`);
			}
			// fill $emit
			if (scriptSetupRanges.emits.define) {
				yield _(`$emit: ${scriptSetupRanges.emits.name ?? '__VLS_emit'},\n`);
			}
		}
	}
	function* generateTemplate(functional: boolean): Generator<CodeAndStack> {

		generatedTemplate = true;

		if (!vueCompilerOptions.skipTemplateCodegen) {
			yield* generateExportOptions();
			yield* generateConstNameOption();
			yield _(`function __VLS_template() {\n`);
			const cssIds = new Set<string>();
			yield* generateTemplateContext(cssIds);
			yield _(`}\n`);
			yield* generateComponentForTemplateUsage(functional, cssIds);
		}
		else {
			yield _(`function __VLS_template() {\n`);
			const templateUsageVars = [...getTemplateUsageVars()];
			yield _(`// @ts-ignore\n`);
			yield _(`[${templateUsageVars.join(', ')}]\n`);
			yield _(`return {};\n`);
			yield _(`}\n`);
		}
	}
	function* generateComponentForTemplateUsage(functional: boolean, cssIds: Set<string>): Generator<CodeAndStack> {

		if (scriptSetup && scriptSetupRanges) {

			yield _(`const __VLS_internalComponent = (await import('${vueCompilerOptions.lib}')).defineComponent({\n`);
			yield _(`setup() {\n`);
			yield _(`return {\n`);
			yield* generateSetupReturns();
			// bindings
			const templateUsageVars = getTemplateUsageVars();
			for (const [content, bindings] of [
				[scriptSetup.content, scriptSetupRanges.bindings] as const,
				scriptRanges && script
					? [script.content, scriptRanges.bindings] as const
					: ['', []] as const,
			]) {
				for (const expose of bindings) {
					const varName = content.substring(expose.start, expose.end);
					if (!templateUsageVars.has(varName) && !cssIds.has(varName)) {
						continue;
					}
					const templateOffset = getGeneratedLength();
					yield _(varName);
					yield _(`: ${varName} as typeof `);

					const scriptOffset = getGeneratedLength();
					yield _(varName);
					yield _(`,\n`);

					linkedCodeMappings.push({
						sourceOffsets: [scriptOffset],
						generatedOffsets: [templateOffset],
						lengths: [varName.length],
						data: undefined,
					});
				}
			}
			yield _(`};\n`); // return {
			yield _(`},\n`); // setup() {
			yield* generateComponentOptions(functional);
			yield _(`});\n`); // defineComponent {
		}
		else if (script) {
			yield _(`let __VLS_internalComponent!: typeof import('./${path.basename(fileName)}')['default'];\n`);
		}
		else {
			yield _(`const __VLS_internalComponent = (await import('${vueCompilerOptions.lib}')).defineComponent({});\n`);
		}
	}
	function* generateExportOptions(): Generator<CodeAndStack> {
		yield _(`\n`);
		yield _(`const __VLS_componentsOption = `);
		if (script && scriptRanges?.exportDefault?.componentsOption) {
			const componentsOption = scriptRanges.exportDefault.componentsOption;
			yield _([
				script.content.substring(componentsOption.start, componentsOption.end),
				'script',
				componentsOption.start,
				disableAllFeatures({
					navigation: true,
				}),
			]);
		}
		else {
			yield _(`{}`);
		}
		yield _(`;\n`);
	}
	function* generateConstNameOption(): Generator<CodeAndStack> {
		yield _(`\n`);
		if (script && scriptRanges?.exportDefault?.nameOption) {
			const nameOption = scriptRanges.exportDefault.nameOption;
			yield _(`const __VLS_name = `);
			yield _(`${script.content.substring(nameOption.start, nameOption.end)} as const`);
			yield _(`;\n`);
		}
		else if (scriptSetup) {
			yield _(`let __VLS_name!: '${path.basename(fileName.substring(0, fileName.lastIndexOf('.')))}';\n`);
		}
		else {
			yield _(`const __VLS_name = undefined;\n`);
		}
	}
	function* generateTemplateContext(cssIds = new Set<string>()): Generator<CodeAndStack> {

		const useGlobalThisTypeInCtx = fileName.endsWith('.html');

		yield _(`let __VLS_ctx!: ${useGlobalThisTypeInCtx ? 'typeof globalThis &' : ''}`);
		yield _(`InstanceType<__VLS_PickNotAny<typeof __VLS_internalComponent, new () => {}>> & {\n`);

		/* CSS Module */
		for (let i = 0; i < styles.length; i++) {
			const style = styles[i];
			if (style.module) {
				yield _(`${style.module}: Record<string, string> & ${helperTypes.Prettify.name}<{}`);
				for (const className of style.classNames) {
					yield* generateCssClassProperty(
						i,
						className.text,
						className.offset,
						'string',
						false,
						true,
					);
				}
				yield _(`>;\n`);
			}
		}
		yield _(`};\n`);

		/* Components */
		yield _(`/* Components */\n`);
		yield _(`let __VLS_otherComponents!: NonNullable<typeof __VLS_internalComponent extends { components: infer C } ? C : {}> & typeof __VLS_componentsOption;\n`);
		yield _(`let __VLS_own!: __VLS_SelfComponent<typeof __VLS_name, typeof __VLS_internalComponent & (new () => { ${getSlotsPropertyName(vueCompilerOptions.target)}: typeof ${scriptSetupRanges?.slots?.name ?? '__VLS_slots'} })>;\n`);
		yield _(`let __VLS_localComponents!: typeof __VLS_otherComponents & Omit<typeof __VLS_own, keyof typeof __VLS_otherComponents>;\n`);
		yield _(`let __VLS_components!: typeof __VLS_localComponents & __VLS_GlobalComponents & typeof __VLS_ctx;\n`); // for html completion, TS references...

		/* Style Scoped */
		yield _(`/* Style Scoped */\n`);
		yield _(`type __VLS_StyleScopedClasses = {}`);
		for (let i = 0; i < styles.length; i++) {
			const style = styles[i];
			const option = vueCompilerOptions.experimentalResolveStyleCssClasses;
			if (option === 'always' || (option === 'scoped' && style.scoped)) {
				for (const className of style.classNames) {
					yield* generateCssClassProperty(
						i,
						className.text,
						className.offset,
						'boolean',
						true,
						!style.module,
					);
				}
			}
		}
		yield _(`;\n`);
		yield _('let __VLS_styleScopedClasses!: __VLS_StyleScopedClasses | keyof __VLS_StyleScopedClasses | (keyof __VLS_StyleScopedClasses)[];\n');

		yield _(`/* CSS variable injection */\n`);
		yield* generateCssVars(cssIds);
		yield _(`/* CSS variable injection end */\n`);

		if (templateCodegen) {
			for (let i = 0; i < templateCodegen.tsCodes.length; i++) {
				yield [
					templateCodegen.tsCodes[i],
					templateCodegen.tsCodegenStacks[i],
				];
			}
		}
		else {
			yield _(`// no template\n`);
			if (!scriptSetupRanges?.slots.define) {
				yield _(`const __VLS_slots = {};\n`);
			}
		}

		yield _(`return ${scriptSetupRanges?.slots.name ?? '__VLS_slots'};\n`);

	}
	function* generateCssClassProperty(
		styleIndex: number,
		classNameWithDot: string,
		offset: number,
		propertyType: string,
		optional: boolean,
		referencesCodeLens: boolean
	): Generator<CodeAndStack> {
		yield _(`\n & { `);
		yield _([
			'',
			'style_' + styleIndex,
			offset,
			disableAllFeatures({
				navigation: true,
				__referencesCodeLens: referencesCodeLens,
			}),
		]);
		yield _(`'`);
		yield _([
			'',
			'style_' + styleIndex,
			offset,
			disableAllFeatures({
				navigation: {
					resolveRenameNewName: normalizeCssRename,
					resolveRenameEditText: applyCssRename,
				},
			}),
		]);
		yield _([
			classNameWithDot.substring(1),
			'style_' + styleIndex,
			offset + 1,
			disableAllFeatures({ __combineLastMappping: true }),
		]);
		yield _(`'`);
		yield _([
			'',
			'style_' + styleIndex,
			offset + classNameWithDot.length,
			disableAllFeatures({}),
		]);
		yield _(`${optional ? '?' : ''}: ${propertyType}`);
		yield _(` }`);
	}
	function* generateCssVars(cssIds: Set<string>): Generator<CodeAndStack> {

		const emptyLocalVars = new Map<string, number>();

		for (const style of styles) {
			for (const cssBind of style.cssVars) {
				for (const [segment, offset, onlyError] of eachInterpolationSegment(
					ts,
					cssBind.text,
					ts.createSourceFile('/a.txt', cssBind.text, 99 satisfies ts.ScriptTarget.ESNext),
					emptyLocalVars,
					cssIds,
					vueCompilerOptions,
				)) {
					if (offset === undefined) {
						yield _(segment);
					}
					else {
						yield _([
							segment,
							style.name,
							cssBind.offset + offset,
							onlyError
								? disableAllFeatures({ verification: true })
								: enableAllFeatures({}),
						]);
					}
				}
				yield _(`;\n`);
			}
		}
	}
	function getTemplateUsageVars() {

		const usageVars = new Set<string>();

		if (templateCodegen) {
			// fix import components unused report
			for (const varName of bindingNames) {
				if (templateCodegen.tagNames.has(varName) || templateCodegen.tagNames.has(hyphenateTag(varName))) {
					usageVars.add(varName);
				}
			}
			for (const tag of Object.keys(templateCodegen.tagNames)) {
				if (tag.indexOf('.') >= 0) {
					usageVars.add(tag.split('.')[0]);
				}
			}
			for (const _id of templateCodegen.accessedGlobalVariables) {
				usageVars.add(_id);
			}
		}

		return usageVars;
	}
	function generateSourceCode(block: SfcBlock, start: number, end?: number): Code {
		return [
			block.content.substring(start, end),
			block.name,
			start,
			enableAllFeatures({}), // diagnostic also working for setup() returns unused in template checking
		];
	}
	function generateSourceCodeForExtraReference(block: SfcBlock, start: number, end: number): Code {
		return [
			block.content.substring(start, end),
			block.name,
			start,
			disableAllFeatures({ navigation: true }),
		];
	}
}

function normalizeCssRename(newName: string) {
	return newName.startsWith('.') ? newName.slice(1) : newName;
}

function applyCssRename(newName: string) {
	return '.' + newName;
}

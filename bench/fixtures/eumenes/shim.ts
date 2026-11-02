/**
 * Stand-ins for the Eumenes modules that `routed-route.ts` and `score.ts` import.
 * The parity tests call only `decide`, `correctProbabilities`, `predictionSet` and
 * `decisionOf`, none of which reads these; the rest is here so the two copied files
 * load without an Eumenes checkout. Not product code.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
export type ToolchainCard = any;
export type ChoiceCandidate = any;
export type Searched = any;
export type RoutedInput = any;
export type NearFeedback = {
	id: string;
	wrongId: string | null;
	rightId: string;
	similarity: number;
};
export type RouterTrace = any;
export type RouterTraceRecord = any;
export type InferencePort = {
	snapshotInTransaction?: () => {
		router: {
			accept: number;
			low: number;
			margin: number;
			approve: number;
			multi: number;
			[key: string]: any;
		};
	};
};
export const ROUTE_LIMITS = { criteria: 24, description: 300, text: 2000 };
export const routeCriterionName = /^[a-z0-9][a-z0-9._:-]*$/;
const unused = (name: string) => (): never => {
	throw new Error(`eumenes_shim_unused: ${name}`);
};
export const routerPassage: (card: any) => string = unused("routerPassage");
export const systemContext: (key: string, variables: any) => string =
	unused("systemContext");
export const lineText = (text: string) => text.replace(/\s+/g, " ").trim();
export const routerSettingsSchema = {
	parse: unused("routerSettingsSchema") as (value: unknown) => any,
};

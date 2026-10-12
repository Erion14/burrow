import type { AppActions, AppState } from "../lib/app-state";

export interface ScreenProps {
	state: AppState;
	actions: AppActions;
}

import {
    getContentTabDisplayTitle,
    getContentTabTooltipTitle,
} from "@/features/workbench/content/content-tab-registry";
import { getConnectionName } from "@/features/workbench/content/content-tab-title-utils";

export { getConnectionName };

export const getTabDisplayTitle = getContentTabDisplayTitle;
export const getTabTooltipTitle = getContentTabTooltipTitle;

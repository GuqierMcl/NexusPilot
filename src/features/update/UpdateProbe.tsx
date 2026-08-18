import { useEffect } from "react";

import { useUpdateController } from "./use-update-controller";

let didRunStartupUpdateCheck = false;

export function UpdateProbe() {
    const { checkForUpdates } = useUpdateController();

    useEffect(() => {
        if (!import.meta.env.PROD) {
            return;
        }

        if (didRunStartupUpdateCheck) {
            return;
        }

        didRunStartupUpdateCheck = true;
        void checkForUpdates("startup");
    }, [checkForUpdates]);

    return null;
}

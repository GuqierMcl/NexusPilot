import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { ConnectionEditDialog } from "@/features/workbench/explorer/components/ConnectionEditDialog";
import { CreateDatabaseDialog } from "@/features/workbench/explorer/components/CreateDatabaseDialog";
import { CreateFolderDialog } from "@/features/workbench/explorer/components/CreateFolderDialog";
import { DeleteDatabaseDialog } from "@/features/workbench/explorer/components/DeleteDatabaseDialog";
import { DeleteNodeDialog } from "@/features/workbench/explorer/components/DeleteNodeDialog";
import { DeleteTableDialog } from "@/features/workbench/explorer/components/DeleteTableDialog";
import { EditDatabaseDialog } from "@/features/workbench/explorer/components/EditDatabaseDialog";
import { RenameNodeDialog } from "@/features/workbench/explorer/components/RenameNodeDialog";
import { SelectDatabaseTypeDialog } from "@/features/workbench/explorer/components/SelectDatabaseTypeDialog";
import type { ConnectionDriver } from "@/types";
import type { ContainerRef } from "@/types/ipc";

import type { ExplorerDialogState } from "./useExplorerDialogState";

interface ExplorerPanelDialogsProps {
    dialogs: ExplorerDialogState;
    onCreateConnectionNext: (
        driver: ConnectionDriver,
        folderId: string | null,
    ) => void;
    onExplorerDataChanged: () => void;
    onDatabaseMutationCompleted: (profileId: string) => void;
    onTableMutationCompleted: (
        profileId: string,
        container: ContainerRef,
    ) => void;
}

export function ExplorerPanelDialogs({
    dialogs,
    onCreateConnectionNext,
    onExplorerDataChanged,
    onDatabaseMutationCompleted,
    onTableMutationCompleted,
}: ExplorerPanelDialogsProps) {
    return (
        <>
            <SelectDatabaseTypeDialog
                open={dialogs.isSelectDbDialogOpen}
                onOpenChange={dialogs.setIsSelectDbDialogOpen}
                targetFolderId={dialogs.targetFolderId}
                onNext={onCreateConnectionNext}
            />

            <ConnectionEditDialog
                open={dialogs.isConnectionEditOpen}
                onOpenChange={dialogs.handleConnectionEditOpenChange}
                mode={dialogs.connectionEditMode}
                driver={dialogs.editingConnection?.driver ?? dialogs.connectionEditDriver}
                folderId={dialogs.connectionEditFolderId}
                initialConnection={dialogs.editingConnection ?? undefined}
                prefillConnection={dialogs.prefillConnection ?? undefined}
                onSaved={onExplorerDataChanged}
            />

            <CreateFolderDialog
                open={dialogs.isCreateFolderDialogOpen}
                onOpenChange={dialogs.setIsCreateFolderDialogOpen}
                targetFolderId={dialogs.targetFolderId}
                onSuccess={onExplorerDataChanged}
            />

            <CreateDatabaseDialog
                open={dialogs.isCreateDatabaseDialogOpen}
                onOpenChange={dialogs.handleCreateDatabaseDialogOpenChange}
                connection={dialogs.createDatabaseConnection}
                onSuccess={() => {
                    if (dialogs.createDatabaseConnection) {
                        onDatabaseMutationCompleted(dialogs.createDatabaseConnection.id);
                    }
                }}
            />

            <EditDatabaseDialog
                open={dialogs.isEditDatabaseDialogOpen}
                onOpenChange={dialogs.handleEditDatabaseDialogOpenChange}
                connection={dialogs.editDatabaseConnection}
                node={dialogs.editingDatabaseNode}
                onSuccess={() => {
                    if (dialogs.editDatabaseConnection) {
                        onDatabaseMutationCompleted(dialogs.editDatabaseConnection.id);
                    }
                }}
            />

            <DeleteDatabaseDialog
                open={dialogs.isDeleteDatabaseDialogOpen}
                onOpenChange={dialogs.handleDeleteDatabaseDialogOpenChange}
                connection={dialogs.deleteDatabaseConnection}
                node={dialogs.deletingDatabaseNode}
                onSuccess={() => {
                    if (dialogs.deleteDatabaseConnection) {
                        onDatabaseMutationCompleted(dialogs.deleteDatabaseConnection.id);
                    }
                }}
                onRefresh={() => {
                    if (dialogs.deleteDatabaseConnection) {
                        onDatabaseMutationCompleted(dialogs.deleteDatabaseConnection.id);
                    }
                }}
            />

            <DeleteTableDialog
                open={dialogs.isDeleteTableDialogOpen}
                onOpenChange={dialogs.handleDeleteTableDialogOpenChange}
                connection={dialogs.deleteTableConnection}
                node={dialogs.deletingTableNode}
                onSuccess={(result) => {
                    if (dialogs.deleteTableConnection) {
                        onTableMutationCompleted(
                            dialogs.deleteTableConnection.id,
                            result.container,
                        );
                    }
                }}
                onRefresh={() => {
                    if (dialogs.deleteTableConnection) {
                        onDatabaseMutationCompleted(dialogs.deleteTableConnection.id);
                    }
                }}
            />

            <RenameNodeDialog
                open={dialogs.isRenameDialogOpen}
                onOpenChange={dialogs.handleRenameDialogOpenChange}
                node={dialogs.renamingNode}
                onSuccess={onExplorerDataChanged}
            />

            <DeleteNodeDialog
                open={dialogs.isDeleteDialogOpen}
                onOpenChange={dialogs.handleDeleteDialogOpenChange}
                node={dialogs.nodeToDelete}
                onSuccess={onExplorerDataChanged}
            />

            <AlertDialog
                open={dialogs.activeConnectionWarning != null}
                onOpenChange={dialogs.handleActiveConnectionWarningOpenChange}
            >
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>
                            {dialogs.activeConnectionWarning?.title}
                        </AlertDialogTitle>
                        <AlertDialogDescription>
                            {dialogs.activeConnectionWarning?.description}
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogAction
                            onClick={() => dialogs.setActiveConnectionWarning(null)}
                        >
                            知道了
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </>
    );
}

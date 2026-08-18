use tauri::State;

use crate::installation::{InstallationIdentity, InstallationIdentityState};

#[tauri::command]
pub fn get_installation_identity(
    state: State<'_, InstallationIdentityState>,
) -> InstallationIdentity {
    state.identity().clone()
}

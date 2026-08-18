use url::Url;

use super::secret::SecretString;

pub(crate) enum AuthCallbackResult {
    AuthorizationCode {
        code: SecretString,
        state: SecretString,
        issuer: Option<String>,
    },
    ProviderError {
        canceled: bool,
        state: SecretString,
        issuer: Option<String>,
    },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum AuthCallbackParseError {
    MissingState,
    MissingResult,
    DuplicateParameter,
    ConflictingResult,
    EmptyParameter,
}

pub(crate) fn parse_auth_callback(url: &Url) -> Result<AuthCallbackResult, AuthCallbackParseError> {
    let mut code = None;
    let mut state = None;
    let mut error = None;
    let mut issuer = None;

    for (key, value) in url.query_pairs() {
        let target = match key.as_ref() {
            "code" => &mut code,
            "state" => &mut state,
            "error" => &mut error,
            "iss" => &mut issuer,
            _ => continue,
        };
        if target.is_some() {
            return Err(AuthCallbackParseError::DuplicateParameter);
        }
        if value.is_empty() {
            return Err(AuthCallbackParseError::EmptyParameter);
        }
        *target = Some(value.into_owned());
    }

    let state = state.ok_or(AuthCallbackParseError::MissingState)?;
    match (code, error) {
        (Some(_), Some(_)) => Err(AuthCallbackParseError::ConflictingResult),
        (Some(code), None) => Ok(AuthCallbackResult::AuthorizationCode {
            code: SecretString::new(code),
            state: SecretString::new(state),
            issuer,
        }),
        (None, Some(error)) => Ok(AuthCallbackResult::ProviderError {
            canceled: error == "access_denied",
            state: SecretString::new(state),
            issuer,
        }),
        (None, None) => Err(AuthCallbackParseError::MissingResult),
    }
}

#[cfg(test)]
mod tests {
    use url::Url;

    use super::{parse_auth_callback, AuthCallbackParseError, AuthCallbackResult};

    #[test]
    fn parses_success_without_exposing_code_through_debug_types() {
        let parsed = parse_auth_callback(
            &Url::parse(
                "dev.nexuspilot://auth/callback?code=secret&state=expected&iss=https%3A%2F%2Fissuer.test",
            )
            .expect("callback URL"),
        )
        .expect("callback should parse");

        match parsed {
            AuthCallbackResult::AuthorizationCode { state, issuer, .. } => {
                assert!(state.constant_time_eq("expected"));
                assert_eq!(issuer.as_deref(), Some("https://issuer.test"));
            }
            AuthCallbackResult::ProviderError { .. } => panic!("expected code callback"),
        }
    }

    #[test]
    fn recognizes_user_cancel_and_rejects_ambiguous_callbacks() {
        let canceled = parse_auth_callback(
            &Url::parse("dev.nexuspilot://auth/callback?error=access_denied&state=expected")
                .expect("callback URL"),
        )
        .expect("cancel callback should parse");
        assert!(matches!(
            canceled,
            AuthCallbackResult::ProviderError { canceled: true, .. }
        ));

        let ambiguous = parse_auth_callback(
            &Url::parse("dev.nexuspilot://auth/callback?code=one&code=two&state=expected")
                .expect("callback URL"),
        );
        assert!(matches!(
            ambiguous,
            Err(AuthCallbackParseError::DuplicateParameter)
        ));

        let conflicting = parse_auth_callback(
            &Url::parse(
                "dev.nexuspilot://auth/callback?code=code&error=server_error&state=expected",
            )
            .expect("callback URL"),
        );
        assert!(matches!(
            conflicting,
            Err(AuthCallbackParseError::ConflictingResult)
        ));

        let missing_state = parse_auth_callback(
            &Url::parse("dev.nexuspilot://auth/callback?code=code").expect("callback URL"),
        );
        assert!(matches!(
            missing_state,
            Err(AuthCallbackParseError::MissingState)
        ));
    }
}

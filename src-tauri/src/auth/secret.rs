use subtle::ConstantTimeEq;
use zeroize::{Zeroize, ZeroizeOnDrop};

#[derive(Clone, Zeroize, ZeroizeOnDrop)]
pub struct SecretString(String);

impl SecretString {
    pub fn new(value: String) -> Self {
        Self(value)
    }

    pub fn expose(&self) -> &str {
        &self.0
    }

    pub fn constant_time_eq(&self, candidate: &str) -> bool {
        bool::from(self.0.as_bytes().ct_eq(candidate.as_bytes()))
    }
}

#[cfg(test)]
mod tests {
    use super::SecretString;

    #[test]
    fn compares_secret_values_without_exposing_debug_output() {
        let secret = SecretString::new("expected-state".to_string());

        assert!(secret.constant_time_eq("expected-state"));
        assert!(!secret.constant_time_eq("unexpected-state"));
    }
}

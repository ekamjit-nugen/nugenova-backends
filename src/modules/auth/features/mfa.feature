Feature: TOTP second factor
  Users can enrol a TOTP authenticator; once enabled, OTP login only issues a
  short-lived challenge and the second factor must be cleared to finish login.

  Scenario: enrolling an authenticator returns a secret then backup codes
    Given a logged-in user without MFA
    When they start MFA setup
    Then the response returns a secret and an otpauth URL
    When they verify MFA with a code generated from that secret
    Then the response returns exactly 10 backup codes

  Scenario: login for an MFA-enabled user returns a challenge instead of tokens
    Given an MFA-enabled user
    When they complete OTP verification
    Then the response signals that MFA is required with a challenge token
    And no access token is issued

  Scenario: completing the second factor finishes the login
    Given an MFA-enabled user
    When they complete OTP verification
    And they answer the MFA challenge with a valid TOTP code
    Then the response is 200 with an access token, a refresh token and the user

  Scenario: a wrong TOTP code fails the second factor
    Given an MFA-enabled user
    When they complete OTP verification
    And they answer the MFA challenge with an invalid code
    Then the response is 401 with error code "MFA_INVALID"

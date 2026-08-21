Feature: Passwordless email-OTP login
  As the login core of Nugenova
  The auth API issues one-time codes and verifies them without ever
  enumerating which emails exist.

  Scenario: send-otp always reports success for a known account
    Given an existing active user
    When they request an OTP for their email
    Then the response is 200 and reports success

  Scenario: send-otp reports success for an unknown email (no enumeration)
    When an OTP is requested for an email that has no account
    Then the response is 200 and reports success

  Scenario: verifying the dev-bypass code logs a brand-new user in
    Given a fresh email that has never logged in
    When they request an OTP and verify the dev-bypass code
    Then the response is 200 with an access token, a refresh token and the user
    And the response flags the account as a new user

  Scenario: a wrong code for a user with a live stored OTP is rejected
    Given an existing active user who has an OTP on file
    When they verify with the wrong six-digit code
    Then the response is 400 with error code "INVALID_OTP"

  @bug
  Scenario: verifying an unknown email returns the generic INVALID_OTP, not 404
    When an unknown email is verified with any six-digit code
    Then the response is 400 with error code "INVALID_OTP"

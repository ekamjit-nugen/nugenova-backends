Feature: Passwordless email-OTP login
  As the login core of Nugenova
  The auth API issues one-time codes to known accounts and verifies them.
  Sign-in is invite-only: an email with no account is rejected outright.

  Scenario: send-otp reports success for a known account
    Given an existing active user
    When they request an OTP for their email
    Then the response is 200 and reports success

  Scenario: send-otp rejects an email with no account
    When an OTP is requested for an email that has no account
    Then the response is 404 with error code "NO_ACCOUNT"
    And no account is created for that email

  Scenario: an invited user's first sign-in is flagged as a new user
    Given an invited user who has never logged in
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

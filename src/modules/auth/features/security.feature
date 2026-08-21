Feature: Session identity, refresh rotation and revocation
  The /me endpoint is gated by a valid Bearer token; refresh tokens rotate their
  family; logout revokes the presented access token.

  Scenario: the current user is returned for a valid Bearer token
    Given a logged-in user without MFA
    When they call GET /auth/me with their access token
    Then the response is 200 and returns their email

  Scenario: GET /auth/me without a token is unauthorized
    When GET /auth/me is called with no token
    Then the response is 401

  Scenario: GET /auth/me with a garbage token is unauthorized
    When GET /auth/me is called with an invalid token
    Then the response is 401

  Scenario: refreshing rotates to a new pair of tokens
    Given a logged-in user without MFA
    When they refresh with their refresh token
    Then the response is 200 and returns a new access and refresh token

  @bug
  Scenario: reusing a refresh token after rotation is rejected
    Given a logged-in user without MFA
    When they refresh with their refresh token
    And they refresh again with the same original refresh token
    Then the response is 401

  @bug
  Scenario: a logged-out access token can no longer authenticate
    Given a logged-in user without MFA
    When they log out with their access token
    And they call GET /auth/me with that same access token
    Then the response is 401

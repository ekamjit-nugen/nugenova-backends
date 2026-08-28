Feature: Profile settings
  A user maintains their own profile via Settings → Profile. The full profile —
  contact, role, bio, location, timezone, social links, avatar — persists and is
  returned by GET /auth/me.

  Scenario: a user updates their profile
    Given a signed-in user
    When they update their profile with contact, role, bio and social details
    Then GET /auth/me returns the updated profile

  Scenario: a name cannot be blanked but other fields can be cleared
    Given a signed-in user with a full profile
    When they submit an empty first name and empty job title
    Then the first name is kept and the job title is cleared

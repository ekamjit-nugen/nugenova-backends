Feature: Permission-scoped role enforcement
  A custom role carries a permission matrix. A member holding a below-admin custom
  role is `permScoped`: the backend enforces their matrix per endpoint — they can
  reach exactly the resources/actions granted, and nothing else. Owner/admin tiers
  bypass the matrix.

  Scenario: a permScoped member can read a resource their role grants
    Given an organization owner who created a "Dept Viewer" role granting departments:view
    And a member assigned that role
    When the member lists departments
    Then the request succeeds

  Scenario: a permScoped member is denied a resource their role does not grant
    Given an organization owner who created a "Dept Viewer" role granting departments:view
    And a member assigned that role
    When the member lists roles
    Then the request is rejected as forbidden

  Scenario: a permScoped member is denied an action their role does not grant
    Given an organization owner who created a "Dept Viewer" role granting departments:view
    And a member assigned that role
    When the member tries to create a department
    Then the request is rejected as forbidden

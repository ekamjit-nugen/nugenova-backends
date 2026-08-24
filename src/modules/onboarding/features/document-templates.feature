Feature: Onboarding document template library
  The super admin picks documents to request from a shared library of built-in
  templates, and can add custom templates of their own.

  Scenario: the built-in document library is available to a super admin
    Given a signed-in super admin
    When they list the document templates
    Then the built-in PAN-card and incorporation-certificate templates are present
    And every built-in template is flagged as built-in

  Scenario: a super admin creates a custom template
    Given a signed-in super admin
    When they create a custom template that requires a signature
    Then the custom template appears in the library
    And it is not flagged as built-in

  Scenario: a super admin deletes a custom template
    Given a super admin has created a custom template
    When they delete that custom template
    Then the custom template no longer appears in the library

  Scenario: built-in templates cannot be deleted
    Given a signed-in super admin
    When they try to delete a built-in template
    Then the deletion is rejected as not found

  @security
  Scenario: a non super admin cannot list document templates
    Given a signed-in ordinary user who is not a platform admin
    When they try to list the document templates
    Then the request is rejected as forbidden

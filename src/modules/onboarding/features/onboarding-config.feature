Feature: Onboarding requirements config
  An org configures what every new hire must submit and complete via the
  onboarding policy config. HR/admin/owner author it; employees never can. When
  no config is saved, sensible catalog defaults apply.

  Scenario: the default onboarding config falls back to catalog defaults
    Given a freshly provisioned organization
    When the owner reads the onboarding config
    Then the config lists the default required documents and a checklist

  Scenario: the owner reads the document catalog
    Given a freshly provisioned organization
    When the owner reads the onboarding catalog
    Then the catalog groups documents and includes the defaults
    And the catalog lists the selectable standard checklist tasks

  Scenario: the owner selects which standard checklist tasks apply
    Given a freshly provisioned organization
    When the owner saves a checklist without the team-introduction task
    Then reading the config back omits the team-introduction task
    And the retained standard tasks keep their canonical keys

  Scenario: the owner customises the onboarding requirements
    Given a freshly provisioned organization
    When the owner saves a config requiring a passport and a six-month probation
    Then reading the config back reflects the passport requirement and probation

  @security
  Scenario: an employee cannot edit the onboarding config
    Given a freshly provisioned organization with an employee member
    When the employee tries to save the onboarding config
    Then the config write is rejected as forbidden

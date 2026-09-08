Feature: Vertical pack — one platform, many verticals by config
  The vertical is a CONFIG object, not a fork. Every org resolves an effective
  pack (vocabulary, enabled modules, AI tier ceiling). A new org defaults to
  'company' and is unchanged. An owner/admin can switch the org to an education
  vertical, which relabels the vocabulary, enables the education modules and
  seeds the education role set. Only an owner/admin may repack an org, and only
  within their own org.

  Scenario: a new org resolves the company pack by default
    Given a newly provisioned organization
    When its owner reads the vertical pack
    Then the pack orgType is company and enables no education modules

  Scenario: an admin switches the org to a school vertical
    Given a newly provisioned organization
    When the owner sets the org type to school
    Then the resolved pack relabels members as students and enables the lms module
    And the education roles are seeded for the org

  Scenario: an employee cannot repack the org
    Given an organization with an employee
    When the employee tries to set the org type
    Then the request is rejected as forbidden

  Scenario: an override can only lower the AI tier ceiling
    Given a school organization
    When the owner tries to raise its AI tier ceiling to three
    Then the resolved ceiling stays capped at one

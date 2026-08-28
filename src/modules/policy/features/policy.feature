Feature: Policies — org-scoped CRUD, roles, isolation, acknowledgement
  Policies are the org's rulebook: a work-timing policy defines the working day
  (clock-in/out, grace, minimum hours), and WFH / work-location rules ride on it.
  Authoring is an admin surface; every employee can read and acknowledge. Access
  is strictly org-scoped — a platform super admin is not an org member and one
  org can never see another's policies.

  Scenario: a new organization is seeded with a default work-timing policy
    Given a freshly provisioned organization
    When its policies are listed
    Then a default work-timing policy applicable to everyone exists

  Scenario: an org admin creates a work-timing policy
    Given an organization
    When the owner creates a work-timing policy starting at "10:00"
    Then the policy is created with that work timing

  Scenario: listing policies returns only the caller's organization
    Given two organizations that each have policies
    When the first organization's owner lists policies
    Then only the first organization's policies are returned

  Scenario: an employee can read policies but cannot create one
    Given an organization with an employee
    When the employee lists policies
    Then the request succeeds
    But when the employee tries to create a policy
    Then the request is rejected as forbidden

  Scenario: a permission-scoped member with policies:create can create a policy
    Given an organization with a policy-author member
    When the policy-author creates a work-timing policy starting at "09:30"
    Then the policy is created with that work timing

  Scenario: a permission-scoped member without policies:create is denied
    Given an organization with an employee
    When the employee tries to create a policy
    Then the request is rejected as forbidden

  Scenario: the platform super admin cannot read an organization's policies
    Given an organization that has policies
    When the platform super admin lists that organization's policies
    Then the request is rejected as forbidden

  Scenario: updating a policy bumps its version
    Given an organization with a work-timing policy
    When the owner updates the policy start time to "11:00"
    Then the policy version is incremented

  Scenario: deleting a policy soft-deletes it
    Given an organization with a work-timing policy
    When the owner deletes the policy
    Then the policy no longer appears in the list

  Scenario: an employee acknowledges a policy that requires acknowledgement
    Given an organization with a policy that requires acknowledgement
    And an employee who has not acknowledged it
    When the employee acknowledges the policy
    Then the acknowledgement is recorded for that employee

  Scenario: a newly created policy starts as a draft
    Given an organization
    When the owner creates a policy without specifying active
    Then the policy is inactive (a draft)

  Scenario: activating a draft does not bump its version
    Given an organization with a draft policy at version 1
    When the owner activates the policy
    Then the policy is active and still at version 1

  Scenario: updating a policy records a version snapshot
    Given an organization with a work-timing policy at version 1
    When the owner updates the policy start time to "11:00"
    Then a version 1 snapshot is kept in the policy history

  Scenario: the owner sees who has not acknowledged a required policy
    Given an organization with a required policy and an employee who has not acknowledged
    When the owner views the acknowledgement status
    Then the employee appears as pending

  Scenario: an employee must accept an outstanding required policy before using the platform
    Given an organization with an active required policy applicable to everyone
    And an employee who has not acknowledged it
    When the employee lists their pending acknowledgements
    Then the required policy is listed as pending
    And once the employee acknowledges it, nothing is pending

  Scenario: the org owner is exempt from the org's own required policies
    Given an organization with an active required policy applicable to everyone
    When the owner lists their pending acknowledgements
    Then the owner has nothing pending
    And the owner is not counted among who must acknowledge the policy

  Scenario: a work-from-office policy from the template requires consent to be geo-located
    Given an organization owner
    When the owner creates a policy from the "Work From Office (Geo-fenced, 2 km)" template
    Then the created policy requires acknowledgement
    And once activated, an applicable employee must consent before it takes effect

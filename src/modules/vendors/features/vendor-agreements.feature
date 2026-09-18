Feature: Vendor agreements — what a vendor signs before they supply people
  An organization authors its vendor paperwork once — an MSA, an NDA, a code of
  conduct — and issues a copy to each vendor. A required agreement that applies
  to a vendor must be signed before that vendor is cleared, and the vendor's
  onboarding status follows the paperwork rather than being set by hand. Until
  the vendor portal exists, an admin records the signature the vendor gave them.

  Scenario: an admin authors a template and issues it to a vendor
    Given an organization with a vendor "Acme Contractors"
    And a required agreement template "Master Services Agreement"
    When the owner issues the required agreements to that vendor
    Then the vendor has an agreement "Master Services Agreement" in draft
    And the vendor is not cleared, with 1 outstanding

  Scenario: the agreement keeps its own copy of the template text
    Given an organization with a vendor "Acme Contractors"
    And a required agreement template "Master Services Agreement"
    And that template has been issued to the vendor
    When the owner rewrites the template text
    Then the vendor's agreement still shows the original text

  Scenario: recording the signature clears the vendor
    Given an organization with a vendor "Acme Contractors"
    And a required agreement template "Master Services Agreement"
    And that template has been issued to the vendor
    When the owner records that "Riya Verma" signed it
    Then the vendor is cleared
    And the vendor's onboarding status is "active"
    And the signature records who recorded it

  Scenario: a signed agreement is a record, not a draft
    Given an organization with a vendor "Acme Contractors"
    And a signed agreement at that vendor
    When the owner tries to edit it
    Then the request is rejected
    And deleting it is rejected too

  Scenario: a template aimed at another service category is not required
    Given an organization with a vendor "Acme Contractors" in "Staffing"
    And a required agreement template that applies only to "Facilities"
    When the owner asks for the vendor's clearance
    Then the vendor is cleared

  Scenario: an expired agreement stops clearing the vendor
    Given an organization with a vendor "Acme Contractors"
    And a required agreement that was signed but has expired
    When the owner asks for the vendor's clearance
    Then the vendor is not cleared
    And the agreement is listed as "expired"

  @security
  Scenario: a member with only vendors:view cannot author templates
    Given an organization and a member whose role grants "vendors:view"
    When that member lists the agreement templates
    Then the list is returned
    But creating a template is rejected as forbidden

  @security
  Scenario: templates never cross organizations
    Given two organizations each with an agreement template
    When the first owner lists the agreement templates
    Then only the first organization's template is listed

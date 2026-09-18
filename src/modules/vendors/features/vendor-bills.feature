Feature: Vendor bills — what a vendor charged us, and paying it
  A vendor bills the organization for the people they supplied. The bill is
  raised against the vendor with a line per contractor, the totals are worked out
  by the server, and it moves draft → approved → paid. Once approved it is a
  financial record: corrections mean cancelling it and raising a new one.

  Scenario: an admin raises a bill for the people a vendor supplied
    Given an organization with a vendor "Acme Contractors" supplying "Amit Sharma"
    When the owner raises a bill for 20 days of "Amit Sharma" at 8000 with 18% tax
    Then the bill is a draft numbered "VB-00001"
    And the bill totals 160000 plus 28800 tax, 188800 in all

  Scenario: the client cannot dictate what a line costs
    Given an organization with a vendor "Acme Contractors" supplying "Amit Sharma"
    When the owner raises a bill whose line also states its own amount
    Then the request is rejected as an unknown field
    And raising the same bill without it stores quantity times rate

  Scenario: a bill cannot charge for someone the vendor does not supply
    Given an organization with two vendors, each supplying one person
    When the owner bills the first vendor for the second vendor's person
    Then the request is rejected

  Scenario: approving then paying a bill
    Given an organization with a vendor "Acme Contractors" supplying "Amit Sharma"
    And a draft bill for that vendor
    When the owner approves the bill
    Then the bill records who approved it
    And it cannot be edited any more
    When the owner marks it paid with reference "UTR-99"
    Then the bill is paid, with that reference

  Scenario: a bill must be approved before it can be paid
    Given an organization with a vendor "Acme Contractors" supplying "Amit Sharma"
    And a draft bill for that vendor
    When the owner tries to mark the draft paid
    Then the request is rejected

  Scenario: cancelling a bill we will not pay
    Given an organization with a vendor "Acme Contractors" supplying "Amit Sharma"
    And a draft bill for that vendor
    When the owner cancels it as "Duplicate"
    Then the bill is cancelled with that reason
    And it no longer counts towards what the vendor has cost us

  Scenario: the cost summary separates what we owe from what we have paid
    Given an organization with a vendor "Acme Contractors" supplying "Amit Sharma"
    And an approved bill of 10000 and a paid bill of 5000
    When the owner asks what that vendor has cost
    Then 10000 is outstanding and 5000 is paid

  @security
  Scenario: a member with only vendors:view cannot raise or approve bills
    Given an organization with a vendor and a member whose role grants "vendors:view"
    When that member lists the bills
    Then the list is returned
    But raising a bill is rejected as forbidden

  @security
  Scenario: bills never cross organizations
    Given two organizations each with a bill
    When the first owner lists the bills
    Then only the first organization's bill is listed

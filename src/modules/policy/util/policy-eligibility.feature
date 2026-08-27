Feature: Policy eligibility — effective window & applicability (G-P3, G-P7)
  A policy only applies to an employee on a given day when it is within its
  effective window AND its applicability matches the employee. A future or
  expired policy must not apply, and department/designation/specific scopes must
  match the right employee attribute.

  Scenario: A policy with no dates is always effective
    Given a policy with no effectiveFrom and no effectiveTo
    Then it is effective on any date

  Scenario: A future-dated policy is not yet effective
    Given a policy with effectiveFrom in the future
    Then it is not effective today

  Scenario: An expired policy is no longer effective
    Given a policy with effectiveTo in the past
    Then it is not effective today

  Scenario: effectiveTo is inclusive to the end of its day
    Given a policy with effectiveTo set to today at midnight UTC
    Then it is still effective later the same day

  Scenario: Within the window it is effective
    Given effectiveFrom last month and effectiveTo next month
    Then it is effective today

  Scenario Outline: Applicability matches the employee scope
    Given a policy with applicableTo "<scope>" targeting "<ids>"
    And an employee in department "d1", designation "g1", id "e1"
    Then applicability match is <result>

    Examples:
      | scope       | ids   | result |
      | all         |       | true   |
      | specific    | e1    | true   |
      | specific    | e9    | false  |
      | department  | d1    | true   |
      | department  | d9    | false  |
      | designation | g1    | true   |
      | designation | g9    | false  |

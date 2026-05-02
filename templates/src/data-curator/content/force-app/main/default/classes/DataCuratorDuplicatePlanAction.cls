public with sharing class DataCuratorDuplicatePlanAction {
    public class Request {
        @InvocableVariable(label='Department Filter' required=false)
        public String department_filter;

        @InvocableVariable(label='Confidence Threshold' required=false)
        public Decimal confidence_threshold;
    }

    public class Response {
        @InvocableVariable
        public String plan_summary;

        @InvocableVariable
        public Integer duplicate_cluster_count;

        @InvocableVariable
        public Decimal projected_monthly_savings;
    }

    @InvocableMethod(label='Data Curator Build Duplicate Cleanup Plan' description='Builds a duplicate cleanup plan for metadata clusters.')
    public static List<Response> run(List<Request> requests) {
        List<Response> responses = new List<Response>();
        for (Request requestItem : requests) {
            DataCuratorGovernanceService.DuplicatePlanResult serviceResult =
                DataCuratorGovernanceService.buildDuplicateCleanupPlan(
                    requestItem.department_filter,
                    requestItem.confidence_threshold
                );
            Response responseItem = new Response();
            responseItem.plan_summary = serviceResult.planSummary;
            responseItem.duplicate_cluster_count = serviceResult.duplicateClusterCount;
            responseItem.projected_monthly_savings = serviceResult.projectedMonthlySavings;
            responses.add(responseItem);
        }
        return responses;
    }
}

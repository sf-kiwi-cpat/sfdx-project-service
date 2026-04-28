public with sharing class DataCuratorRunStaleMetadataReviewAction {
    public class Request {
        @InvocableVariable(label='Department Filter' required=false)
        public String department_filter;

        @InvocableVariable(label='Stale Threshold Days' required=false)
        public Integer stale_threshold_days;
    }

    public class Response {
        @InvocableVariable
        public String review_snapshot;

        @InvocableVariable
        public Integer stale_asset_count;

        @InvocableVariable
        public Integer critical_asset_count;
    }

    @InvocableMethod(label='Data Curator Run Stale Metadata Review' description='Finds stale metadata assets for review.')
    public static List<Response> run(List<Request> requests) {
        List<Response> responses = new List<Response>();
        for (Request requestItem : requests) {
            DataCuratorGovernanceService.StaleReviewResult serviceResult =
                DataCuratorGovernanceService.runStaleReview(
                    requestItem.department_filter,
                    requestItem.stale_threshold_days
                );
            Response responseItem = new Response();
            responseItem.review_snapshot = serviceResult.reviewSnapshot;
            responseItem.stale_asset_count = serviceResult.staleAssetCount;
            responseItem.critical_asset_count = serviceResult.criticalAssetCount;
            responses.add(responseItem);
        }
        return responses;
    }
}


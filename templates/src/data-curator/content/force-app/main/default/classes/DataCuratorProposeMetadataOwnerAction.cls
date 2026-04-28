public with sharing class DataCuratorProposeMetadataOwnerAction {
    public class Request {
        @InvocableVariable(label='Asset Name' required=false)
        public String asset_name;

        @InvocableVariable(label='Department Filter' required=false)
        public String department_filter;
    }

    public class Response {
        @InvocableVariable
        public String asset_name;

        @InvocableVariable
        public String recommended_owner_id;

        @InvocableVariable
        public String recommended_owner_name;

        @InvocableVariable
        public String reasoning_summary;
    }

    @InvocableMethod(label='Data Curator Propose Metadata Owner' description='Recommends the best owner for a metadata asset.')
    public static List<Response> run(List<Request> requests) {
        List<Response> responses = new List<Response>();
        for (Request requestItem : requests) {
            DataCuratorGovernanceService.OwnerProposalResult serviceResult =
                DataCuratorGovernanceService.proposeOwnerAssignment(
                    requestItem.asset_name,
                    requestItem.department_filter
                );
            Response responseItem = new Response();
            responseItem.asset_name = serviceResult.assetName;
            responseItem.recommended_owner_id = String.valueOf(serviceResult.recommendedOwnerId);
            responseItem.recommended_owner_name = serviceResult.recommendedOwnerName;
            responseItem.reasoning_summary = serviceResult.reasoningSummary;
            responses.add(responseItem);
        }
        return responses;
    }
}

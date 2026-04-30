public with sharing class DataCuratorCleanupBriefAction {
    public class Request {
        @InvocableVariable(label='Request Context' required=false)
        public String request_context;

        @InvocableVariable(label='Plan Summary' required=true)
        public String plan_summary;
    }

    public class Response {
        @InvocableVariable
        public String promptResponse;
    }

    @InvocableMethod(label='Data Curator Generate Cleanup Summary' description='Generates an approval-ready duplicate cleanup summary.')
    public static List<Response> run(List<Request> requests) {
        List<Response> responses = new List<Response>();
        for (Request requestItem : requests) {
            Response responseItem = new Response();
            responseItem.promptResponse = DataCuratorGovernanceService.generateCleanupSummary(
                requestItem.request_context,
                requestItem.plan_summary
            );
            responses.add(responseItem);
        }
        return responses;
    }
}

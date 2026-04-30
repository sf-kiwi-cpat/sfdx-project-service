public with sharing class DataCuratorStaleBriefAction {
    public class Request {
        @InvocableVariable(label='Request Context' required=false)
        public String request_context;

        @InvocableVariable(label='Review Snapshot' required=true)
        public String review_snapshot;
    }

    public class Response {
        @InvocableVariable
        public String promptResponse;
    }

    @InvocableMethod(label='Data Curator Generate Stale Brief' description='Generates a concise stale metadata brief from the stale review snapshot.')
    public static List<Response> run(List<Request> requests) {
        List<Response> responses = new List<Response>();
        for (Request requestItem : requests) {
            Response responseItem = new Response();
            responseItem.promptResponse = DataCuratorGovernanceService.generateStaleBrief(
                requestItem.request_context,
                requestItem.review_snapshot
            );
            responses.add(responseItem);
        }
        return responses;
    }
}

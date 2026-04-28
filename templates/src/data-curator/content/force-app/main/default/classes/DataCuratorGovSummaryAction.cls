public with sharing class DataCuratorGovSummaryAction {
    public class Request {
        @InvocableVariable(label='Request Context' required=false)
        public String request_context;

        @InvocableVariable(label='Inventory Snapshot' required=true)
        public String inventory_snapshot;
    }

    public class Response {
        @InvocableVariable
        public String promptResponse;
    }

    @InvocableMethod(label='Data Curator Generate Governance Summary' description='Generates an executive governance summary from the current inventory snapshot.')
    public static List<Response> run(List<Request> requests) {
        List<Response> responses = new List<Response>();
        for (Request requestItem : requests) {
            Response responseItem = new Response();
            responseItem.promptResponse = DataCuratorGovernanceService.generateGovernanceSummary(
                requestItem.request_context,
                requestItem.inventory_snapshot
            );
            responses.add(responseItem);
        }
        return responses;
    }
}

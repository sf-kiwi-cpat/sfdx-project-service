public with sharing class DataCuratorGetMetadataInventoryAction {
    public class Request {
        @InvocableVariable(label='Department Filter' required=false)
        public String department_filter;

        @InvocableVariable(label='Status Filter' required=false)
        public String status_filter;
    }

    public class Response {
        @InvocableVariable
        public String inventory_snapshot;

        @InvocableVariable
        public String department_filter_used;

        @InvocableVariable
        public Decimal health_score;

        @InvocableVariable
        public Integer unassigned_count;

        @InvocableVariable
        public Integer stale_count;
    }

    @InvocableMethod(label='Data Curator Get Metadata Inventory' description='Returns current metadata inventory metrics.')
    public static List<Response> run(List<Request> requests) {
        List<Response> responses = new List<Response>();
        for (Request requestItem : requests) {
            DataCuratorGovernanceService.InventoryResult serviceResult =
                DataCuratorGovernanceService.getMetadataInventory(requestItem.department_filter, requestItem.status_filter);
            Response responseItem = new Response();
            responseItem.inventory_snapshot = serviceResult.inventorySnapshot;
            responseItem.department_filter_used = serviceResult.departmentFilterUsed;
            responseItem.health_score = serviceResult.healthScore;
            responseItem.unassigned_count = serviceResult.unassignedCount;
            responseItem.stale_count = serviceResult.staleCount;
            responses.add(responseItem);
        }
        return responses;
    }
}


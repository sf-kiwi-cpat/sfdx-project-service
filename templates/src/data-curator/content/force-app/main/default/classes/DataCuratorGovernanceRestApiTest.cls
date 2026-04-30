@IsTest
private class DataCuratorGovernanceRestApiTest {
    @TestSetup
    static void setupData() {
        User ownerOne = createUser('governance.one');
        User ownerTwo = createUser('governance.two');

        insert new List<Metadata_Asset__c>{
            new Metadata_Asset__c(
                Name = 'Finance Ledgers',
                API_Name__c = 'Finance_Ledgers__mdt',
                Asset_Type__c = 'Object',
                Department__c = 'Finance',
                Owner_User__c = ownerOne.Id,
                Health_Status__c = 'Healthy',
                Health_Score__c = 95,
                Risk_Level__c = 'Medium',
                Last_Used_On__c = Date.today().addDays(-5),
                Last_Attested_On__c = Date.today().addDays(-10),
                Stale_Days__c = 5,
                Source_System__c = 'Core'
            ),
            new Metadata_Asset__c(
                Name = 'Security Auth Logs',
                API_Name__c = 'Security_Auth_Logs__mdt',
                Asset_Type__c = 'Integration',
                Department__c = 'Security',
                Health_Status__c = 'Stale',
                Health_Score__c = 25,
                Risk_Level__c = 'Critical',
                Last_Used_On__c = Date.today().addDays(-240),
                Last_Attested_On__c = Date.today().addDays(-240),
                Stale_Days__c = 240,
                Source_System__c = 'Shield'
            )
        };

        insert new Governance_Task__c(
            Name = 'Review stale integrations',
            Assigned_To__c = ownerTwo.Id,
            Due_On__c = Date.today().addDays(3),
            Priority__c = 'High',
            Status__c = 'New',
            Task_Type__c = 'Attestation',
            Recommended_Action__c = 'Review stale integration assets.'
        );

        insert new Governance_Event__c(
            Name = 'Seed Event',
            Event_Type__c = 'ScanCompleted',
            Severity__c = 'Info',
            Occurred_On__c = System.now(),
            Actor_Label__c = 'Data Curator',
            Details__c = 'Seeded event log.'
        );
    }

    @IsTest
    static void bootstrapShouldReturnAssetsTasksEventsAndUsers() {
        RestContext.request = new RestRequest();
        RestContext.request.requestUri = '/services/apexrest/data-curator/v1/bootstrap';
        RestContext.request.httpMethod = 'GET';
        RestContext.response = new RestResponse();

        Test.startTest();
        DataCuratorGovernanceRestApi.handleGet();
        Test.stopTest();

        DataCuratorGovernanceRestApi.BootstrapResponse responseBody =
            (DataCuratorGovernanceRestApi.BootstrapResponse) JSON.deserialize(
                RestContext.response.responseBody.toString(),
                DataCuratorGovernanceRestApi.BootstrapResponse.class
            );

        System.assertEquals(200, RestContext.response.statusCode);
        System.assert(responseBody.assets.size() >= 2);
        System.assert(responseBody.tasks.size() >= 1);
        System.assert(responseBody.eventLogs.size() >= 1);
        System.assert(responseBody.users.size() >= 1);
    }

    @IsTest
    static void createAssetTaskAndAssignOwnerShouldPersist() {
        User ownerUser = [SELECT Id FROM User WHERE Email LIKE 'governance.one%@example.com' LIMIT 1];

        runPost(
            '/services/apexrest/data-curator/v1/assets',
            '{"name":"Marketing Prompt Router","assetType":"Flow","department":"Marketing","ownerUserId":"' + ownerUser.Id + '","healthStatus":"Healthy"}'
        );
        Metadata_Asset__c createdAsset = [
            SELECT Id, Name, Owner_User__c
            FROM Metadata_Asset__c
            WHERE Name = 'Marketing Prompt Router'
            LIMIT 1
        ];
        System.assertEquals(ownerUser.Id, createdAsset.Owner_User__c);

        runPost(
            '/services/apexrest/data-curator/v1/tasks',
            '{"title":"Follow up on prompt coverage","ownerUserId":"' + ownerUser.Id + '","dueDate":"' + String.valueOf(Date.today().addDays(4)) + '","priority":"Critical","taskType":"Exception","metadataAssetId":"' + createdAsset.Id + '"}'
        );
        Governance_Task__c createdTask = [
            SELECT Name, Metadata_Asset__c, Priority__c
            FROM Governance_Task__c
            WHERE Name = 'Follow up on prompt coverage'
            LIMIT 1
        ];
        System.assertEquals(createdAsset.Id, createdTask.Metadata_Asset__c);
        System.assertEquals('Critical', createdTask.Priority__c);

        runPost(
            '/services/apexrest/data-curator/v1/actions/assign-owner',
            '{"assetId":"' + createdAsset.Id + '","ownerUserId":"' + UserInfo.getUserId() + '"}'
        );
        createdAsset = [SELECT Owner_User__c FROM Metadata_Asset__c WHERE Id = :createdAsset.Id];
        System.assertEquals(UserInfo.getUserId(), createdAsset.Owner_User__c);
    }

    @IsTest
    static void scansAndBulkActionsShouldPersist() {
        List<Metadata_Asset__c> assets = [
            SELECT Id, Name, Health_Status__c, Health_Score__c
            FROM Metadata_Asset__c
            ORDER BY Name ASC
        ];

        runPost('/services/apexrest/data-curator/v1/actions/full-scan', '{}');
        runPost('/services/apexrest/data-curator/v1/actions/stale-review', '{"staleThresholdDays":180}');
        runPost(
            '/services/apexrest/data-curator/v1/actions/bulk',
            '{"assetIds":["' + assets[0].Id + '","' + assets[1].Id + '"],"action":"mark_healthy"}'
        );

        System.assertEquals(2, [SELECT COUNT() FROM Scan_Run__c]);
        System.assert(
            [SELECT COUNT() FROM Governance_Event__c WHERE Name LIKE 'Full Inventory Scan Completed%'] >= 1
        );

        List<Metadata_Asset__c> refreshedAssets = [
            SELECT Id, Health_Status__c, Health_Score__c
            FROM Metadata_Asset__c
            WHERE Id IN :new Map<Id, Metadata_Asset__c>(assets).keySet()
        ];
        for (Metadata_Asset__c refreshedAsset : refreshedAssets) {
            System.assertEquals('Healthy', refreshedAsset.Health_Status__c);
            System.assert(refreshedAsset.Health_Score__c >= 92);
        }
    }

    @IsTest
    static void exportShouldCreateAuditEvent() {
        runPost(
            '/services/apexrest/data-curator/v1/actions/export',
            '{"format":"csv","rowCount":12,"department":"Finance","type":"Object","status":"Stale","ownership":"Assigned"}'
        );

        Governance_Event__c exportEvent = [
            SELECT Name, Details__c, Event_Type__c, Severity__c
            FROM Governance_Event__c
            WHERE Name = 'Explorer Export Generated'
            ORDER BY CreatedDate DESC
            LIMIT 1
        ];

        System.assertEquals('AgentRecommendation', exportEvent.Event_Type__c);
        System.assertEquals('Info', exportEvent.Severity__c);
        System.assert(exportEvent.Details__c.contains('12 rows as CSV'));
        System.assert(exportEvent.Details__c.contains('Department: Finance'));
    }

    @IsTest
    static void importAssetsShouldUpsertUsingExternalKey() {
        runPost(
            '/services/apexrest/data-curator/v1/actions/import-assets',
            '{"assets":[{"externalKey":"object:Case_Test__c","name":"Case Test","apiName":"Case_Test__c","assetType":"Object","department":"Data Model","healthStatus":"Healthy","healthScore":91,"riskLevel":"Medium","sourceSystem":"Salesforce Org Scan","stewardshipNotes":"Imported object."},{"externalKey":"field:Case_Test__c.Status__c","name":"Case Test.Status__c","apiName":"Case_Test__c.Status__c","assetType":"Field","department":"Data Model","healthStatus":"Healthy","healthScore":88,"riskLevel":"Medium","sourceSystem":"Salesforce Org Scan","stewardshipNotes":"Imported field."}]}'
        );

        List<Metadata_Asset__c> importedAssets = [
            SELECT External_Key__c, Name, API_Name__c, Asset_Type__c, Source_System__c
            FROM Metadata_Asset__c
            WHERE External_Key__c IN ('object:Case_Test__c', 'field:Case_Test__c.Status__c')
            ORDER BY External_Key__c
        ];
        System.assertEquals(2, importedAssets.size());
        System.assertEquals('Salesforce Org Scan', importedAssets[0].Source_System__c);

        runPost(
            '/services/apexrest/data-curator/v1/actions/import-assets',
            '{"assets":[{"externalKey":"object:Case_Test__c","name":"Case Test Updated","apiName":"Case_Test__c","assetType":"Object","department":"Data Model","healthStatus":"NeedsReview","healthScore":74,"riskLevel":"High","sourceSystem":"Salesforce Org Scan","stewardshipNotes":"Updated object."}]}'
        );

        Metadata_Asset__c refreshedObject = [
            SELECT Name, Health_Status__c, Health_Score__c, Risk_Level__c, Stewardship_Notes__c
            FROM Metadata_Asset__c
            WHERE External_Key__c = 'object:Case_Test__c'
            LIMIT 1
        ];
        System.assertEquals('Case Test Updated', refreshedObject.Name);
        System.assertEquals('NeedsReview', refreshedObject.Health_Status__c);
        System.assertEquals(74, refreshedObject.Health_Score__c);
        System.assertEquals('High', refreshedObject.Risk_Level__c);
        System.assertEquals('Updated object.', refreshedObject.Stewardship_Notes__c);
    }

    private static void runPost(String requestUri, String body) {
        RestContext.request = new RestRequest();
        RestContext.request.requestUri = requestUri;
        RestContext.request.httpMethod = 'POST';
        RestContext.request.requestBody = Blob.valueOf(body);
        RestContext.response = new RestResponse();

        DataCuratorGovernanceRestApi.handlePost();

        System.assertEquals(200, RestContext.response.statusCode);
    }

    private static User createUser(String userKey) {
        Profile profileRecord = [SELECT Id FROM Profile WHERE Id = :UserInfo.getProfileId() LIMIT 1];
        String uniqueFragment = String.valueOf(Crypto.getRandomInteger()).replace('-', '');
        User testUser = new User(
            Alias = userKey.substring(Math.max(0, userKey.length() - 4)),
            Email = userKey + uniqueFragment + '@example.com',
            EmailEncodingKey = 'UTF-8',
            LastName = 'Curator',
            LanguageLocaleKey = 'en_US',
            LocaleSidKey = 'en_US',
            ProfileId = profileRecord.Id,
            TimeZoneSidKey = 'America/New_York',
            UserName = userKey + '.' + uniqueFragment + '@example.com'
        );
        insert testUser;
        return testUser;
    }
}

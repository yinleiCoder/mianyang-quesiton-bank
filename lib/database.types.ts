export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      approvals: {
        Row: {
          assigned_user_id: string | null
          comment: string | null
          created_at: string
          decided_at: string | null
          decided_by: string | null
          id: string
          kind: string
          question_id: string
          stage: string
          state: string
          version_id: string | null
        }
        Insert: {
          assigned_user_id?: string | null
          comment?: string | null
          created_at?: string
          decided_at?: string | null
          decided_by?: string | null
          id?: string
          kind?: string
          question_id: string
          stage: string
          state?: string
          version_id?: string | null
        }
        Update: {
          assigned_user_id?: string | null
          comment?: string | null
          created_at?: string
          decided_at?: string | null
          decided_by?: string | null
          id?: string
          kind?: string
          question_id?: string
          stage?: string
          state?: string
          version_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "approvals_question_id_fkey"
            columns: ["question_id"]
            isOneToOne: false
            referencedRelation: "questions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "approvals_version_id_fkey"
            columns: ["version_id"]
            isOneToOne: false
            referencedRelation: "question_versions"
            referencedColumns: ["id"]
          },
        ]
      }
      approver_assignments: {
        Row: {
          created_at: string
          created_by: string
          id: string
          is_active: boolean
          node_id: string
          role: Database["public"]["Enums"]["assignee_role"]
          school_id: string | null
          user_id: string
        }
        Insert: {
          created_at?: string
          created_by: string
          id?: string
          is_active?: boolean
          node_id: string
          role: Database["public"]["Enums"]["assignee_role"]
          school_id?: string | null
          user_id: string
        }
        Update: {
          created_at?: string
          created_by?: string
          id?: string
          is_active?: boolean
          node_id?: string
          role?: Database["public"]["Enums"]["assignee_role"]
          school_id?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "approver_assignments_node_id_fkey"
            columns: ["node_id"]
            isOneToOne: false
            referencedRelation: "subject_nodes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "approver_assignments_school_id_fkey"
            columns: ["school_id"]
            isOneToOne: false
            referencedRelation: "schools"
            referencedColumns: ["id"]
          },
        ]
      }
      audit_log: {
        Row: {
          action: string
          created_at: string
          detail: Json
          id: number
          question_id: string | null
          user_id: string | null
          version_id: string | null
        }
        Insert: {
          action: string
          created_at?: string
          detail?: Json
          id?: never
          question_id?: string | null
          user_id?: string | null
          version_id?: string | null
        }
        Update: {
          action?: string
          created_at?: string
          detail?: Json
          id?: never
          question_id?: string | null
          user_id?: string | null
          version_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "audit_log_question_id_fkey"
            columns: ["question_id"]
            isOneToOne: false
            referencedRelation: "questions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "audit_log_version_id_fkey"
            columns: ["version_id"]
            isOneToOne: false
            referencedRelation: "question_versions"
            referencedColumns: ["id"]
          },
        ]
      }
      media_objects: {
        Row: {
          bucket: string
          created_at: string
          id: string
          mime: string | null
          object_key: string
          sha256: string | null
          size: number
          uploaded_by: string
        }
        Insert: {
          bucket: string
          created_at?: string
          id?: string
          mime?: string | null
          object_key: string
          sha256?: string | null
          size?: number
          uploaded_by: string
        }
        Update: {
          bucket?: string
          created_at?: string
          id?: string
          mime?: string | null
          object_key?: string
          sha256?: string | null
          size?: number
          uploaded_by?: string
        }
        Relationships: []
      }
      profiles: {
        Row: {
          created_at: string
          email: string
          is_admin: boolean
          name: string
          school_id: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          email: string
          is_admin?: boolean
          name: string
          school_id?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          email?: string
          is_admin?: boolean
          name?: string
          school_id?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "profiles_school_id_fkey"
            columns: ["school_id"]
            isOneToOne: false
            referencedRelation: "schools"
            referencedColumns: ["id"]
          },
        ]
      }
      question_versions: {
        Row: {
          base_version_id: string | null
          change_type: string
          content: Json
          created_at: string
          created_by: string
          difficulty: number
          id: string
          published_at: string | null
          qtype: string
          question_id: string
          search_text: string
          status: string
          submitted_at: string | null
          version_no: number
        }
        Insert: {
          base_version_id?: string | null
          change_type: string
          content?: Json
          created_at?: string
          created_by: string
          difficulty?: number
          id?: string
          published_at?: string | null
          qtype: string
          question_id: string
          search_text?: string
          status?: string
          submitted_at?: string | null
          version_no: number
        }
        Update: {
          base_version_id?: string | null
          change_type?: string
          content?: Json
          created_at?: string
          created_by?: string
          difficulty?: number
          id?: string
          published_at?: string | null
          qtype?: string
          question_id?: string
          search_text?: string
          status?: string
          submitted_at?: string | null
          version_no?: number
        }
        Relationships: [
          {
            foreignKeyName: "question_versions_base_version_id_fkey"
            columns: ["base_version_id"]
            isOneToOne: false
            referencedRelation: "question_versions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "question_versions_question_id_fkey"
            columns: ["question_id"]
            isOneToOne: false
            referencedRelation: "questions"
            referencedColumns: ["id"]
          },
        ]
      }
      questions: {
        Row: {
          course_node_id: string
          created_at: string
          creator_id: string
          current_published_version_id: string | null
          id: string
          school_id: string
          state: string
          updated_at: string
        }
        Insert: {
          course_node_id: string
          created_at?: string
          creator_id: string
          current_published_version_id?: string | null
          id?: string
          school_id: string
          state?: string
          updated_at?: string
        }
        Update: {
          course_node_id?: string
          created_at?: string
          creator_id?: string
          current_published_version_id?: string | null
          id?: string
          school_id?: string
          state?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "fk_questions_current_version"
            columns: ["current_published_version_id"]
            isOneToOne: false
            referencedRelation: "question_versions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "questions_course_node_id_fkey"
            columns: ["course_node_id"]
            isOneToOne: false
            referencedRelation: "subject_nodes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "questions_school_id_fkey"
            columns: ["school_id"]
            isOneToOne: false
            referencedRelation: "schools"
            referencedColumns: ["id"]
          },
        ]
      }
      schools: {
        Row: {
          code: string
          created_at: string
          id: string
          is_active: boolean
          name: string
          updated_at: string
        }
        Insert: {
          code: string
          created_at?: string
          id?: string
          is_active?: boolean
          name: string
          updated_at?: string
        }
        Update: {
          code?: string
          created_at?: string
          id?: string
          is_active?: boolean
          name?: string
          updated_at?: string
        }
        Relationships: []
      }
      subject_nodes: {
        Row: {
          created_at: string
          created_by: string
          id: string
          is_frozen: boolean
          kind: Database["public"]["Enums"]["subject_kind"]
          name: string
          parent_id: string | null
          scope: Database["public"]["Enums"]["subject_scope"]
          sort_order: number
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by: string
          id?: string
          is_frozen?: boolean
          kind: Database["public"]["Enums"]["subject_kind"]
          name: string
          parent_id?: string | null
          scope: Database["public"]["Enums"]["subject_scope"]
          sort_order?: number
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string
          id?: string
          is_frozen?: boolean
          kind?: Database["public"]["Enums"]["subject_kind"]
          name?: string
          parent_id?: string | null
          scope?: Database["public"]["Enums"]["subject_scope"]
          sort_order?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "subject_nodes_parent_id_fkey"
            columns: ["parent_id"]
            isOneToOne: false
            referencedRelation: "subject_nodes"
            referencedColumns: ["id"]
          },
        ]
      }
      tags: {
        Row: {
          created_at: string
          created_by: string | null
          id: string
          name: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          id?: string
          name: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          id?: string
          name?: string
        }
        Relationships: []
      }
      user_roles: {
        Row: {
          created_at: string
          created_by: string
          id: string
          role: string
          user_id: string
        }
        Insert: {
          created_at?: string
          created_by: string
          id?: string
          role: string
          user_id: string
        }
        Update: {
          created_at?: string
          created_by?: string
          id?: string
          role?: string
          user_id?: string
        }
        Relationships: []
      }
      version_media: {
        Row: {
          media_object_id: string
          version_id: string
        }
        Insert: {
          media_object_id: string
          version_id: string
        }
        Update: {
          media_object_id?: string
          version_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "version_media_media_object_id_fkey"
            columns: ["media_object_id"]
            isOneToOne: false
            referencedRelation: "media_objects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "version_media_version_id_fkey"
            columns: ["version_id"]
            isOneToOne: false
            referencedRelation: "question_versions"
            referencedColumns: ["id"]
          },
        ]
      }
      version_tags: {
        Row: {
          tag_id: string
          tag_name: string
          version_id: string
        }
        Insert: {
          tag_id: string
          tag_name: string
          version_id: string
        }
        Update: {
          tag_id?: string
          tag_name?: string
          version_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "version_tags_tag_id_fkey"
            columns: ["tag_id"]
            isOneToOne: false
            referencedRelation: "tags"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "version_tags_version_id_fkey"
            columns: ["version_id"]
            isOneToOne: false
            referencedRelation: "question_versions"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      admin_assign_school_admin: {
        Args: { p_user_id: string }
        Returns: undefined
      }
      admin_create_school: {
        Args: { p_code: string; p_name: string }
        Returns: string
      }
      admin_create_subject_node: {
        Args: {
          p_kind: Database["public"]["Enums"]["subject_kind"]
          p_name: string
          p_parent_id: string
          p_scope: Database["public"]["Enums"]["subject_scope"]
          p_sort_order?: number
        }
        Returns: string
      }
      admin_delete_node: { Args: { p_node_id: string }; Returns: undefined }
      admin_direct_update_question: {
        Args: {
          p_content: Json
          p_difficulty: number
          p_qtype: string
          p_question_id: string
          p_tag_ids?: string[]
        }
        Returns: undefined
      }
      admin_gc_media: { Args: { p_max_age_days?: number }; Returns: number }
      admin_merge_tag: {
        Args: { p_from_tag: string; p_to_tag: string }
        Returns: undefined
      }
      admin_move_node: {
        Args: { p_new_parent: string; p_node_id: string }
        Returns: undefined
      }
      admin_rename_node: {
        Args: { p_name: string; p_node_id: string }
        Returns: undefined
      }
      admin_rename_tag: {
        Args: { p_new_name: string; p_tag_id: string }
        Returns: undefined
      }
      admin_revoke_school_admin: {
        Args: { p_user_id: string }
        Returns: undefined
      }
      admin_set_node_frozen: {
        Args: { p_frozen: boolean; p_node_id: string }
        Returns: undefined
      }
      admin_set_question_state: {
        Args: { p_offline: boolean; p_question_id: string }
        Returns: undefined
      }
      admin_set_school_active: {
        Args: { p_active: boolean; p_school_id: string }
        Returns: undefined
      }
      admin_set_user_school: {
        Args: { p_school_id: string; p_user_id: string }
        Returns: undefined
      }
      assign_city_expert: {
        Args: { p_node_id: string; p_user_id: string }
        Returns: string
      }
      assign_group_leader: {
        Args: { p_node_id: string; p_user_id: string }
        Returns: string
      }
      audit: {
        Args: {
          p_action: string
          p_detail?: Json
          p_question_id?: string
          p_version_id?: string
        }
        Returns: undefined
      }
      can_attach_question: {
        Args: { p_node: Database["public"]["Tables"]["subject_nodes"]["Row"] }
        Returns: boolean
      }
      check_can_author: { Args: { p_course_node: string }; Returns: string }
      check_tags_exist: { Args: { p_tag_ids: string[] }; Returns: undefined }
      collect_media_keys: { Args: { c: Json }; Returns: string[] }
      create_question_draft: {
        Args: {
          p_content: Json
          p_course_node: string
          p_difficulty: number
          p_qtype: string
          p_tag_ids?: string[]
        }
        Returns: string
      }
      create_tag: { Args: { p_name: string }; Returns: string }
      delete_question_draft: {
        Args: { p_question_id: string }
        Returns: undefined
      }
      delete_unreferenced_media: {
        Args: { p_media_ids: string[] }
        Returns: undefined
      }
      effective_assignee: {
        Args: {
          p_exclude?: string[]
          p_node: string
          p_role: Database["public"]["Enums"]["assignee_role"]
          p_school: string
        }
        Returns: string
      }
      is_admin: { Args: never; Returns: boolean }
      is_school_admin: { Args: { p_school_id: string }; Returns: boolean }
      question_search_text: { Args: { content: Json }; Returns: string }
      register_media: {
        Args: {
          p_bucket: string
          p_mime?: string
          p_object_key: string
          p_sha256?: string
          p_size: number
        }
        Returns: string
      }
      replace_version_tags: {
        Args: { p_tag_ids: string[]; p_version_id: string }
        Returns: undefined
      }
      request_question_state_change: {
        Args: { p_offline: boolean; p_question_id: string }
        Returns: undefined
      }
      require_uid: { Args: never; Returns: string }
      retract_question: { Args: { p_version_id: string }; Returns: undefined }
      review_decide: {
        Args: { p_approval_id: string; p_comment?: string; p_pass: boolean }
        Returns: undefined
      }
      revoke_approver: { Args: { p_assignment_id: string }; Returns: undefined }
      show_limit: { Args: never; Returns: number }
      show_trgm: { Args: { "": string }; Returns: string[] }
      submit_question: { Args: { p_version_id: string }; Returns: undefined }
      sync_version_media: {
        Args: { p_content: Json; p_version_id: string }
        Returns: undefined
      }
      transfer_approval: {
        Args: { p_approval_id: string; p_to_user: string }
        Returns: undefined
      }
      update_question_draft: {
        Args: {
          p_content: Json
          p_difficulty: number
          p_qtype: string
          p_tag_ids?: string[]
          p_version_id: string
        }
        Returns: undefined
      }
      v_blank_count: { Args: { text_str: string }; Returns: number }
      v_blocks_text: { Args: { blocks: Json }; Returns: string }
      v_choice: {
        Args: { ans: Json; opt: Json; single: boolean }
        Returns: undefined
      }
      v_simple_question: {
        Args: { content: Json; qtype: string }
        Returns: undefined
      }
      validate_question_content: {
        Args: { content: Json; qtype: string }
        Returns: undefined
      }
      write_audit: {
        Args: {
          p_action: string
          p_detail?: Json
          p_question_id: string
          p_version_id: string
        }
        Returns: undefined
      }
    }
    Enums: {
      assignee_role: "group_leader" | "city_expert"
      subject_kind: "discipline" | "category" | "major" | "course"
      subject_scope: "common" | "vocational"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][EnumName]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      assignee_role: ["group_leader", "city_expert"],
      subject_kind: ["discipline", "category", "major", "course"],
      subject_scope: ["common", "vocational"],
    },
  },
} as const
